import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const prefix = "ai_phone_chat_offline_turns:";
const date = day => `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`;
const session = (id, day, contactId = "A") => ({ id, contactId, updatedAt: date(day), unreadCount: 0 });
const turn = (sessionId, id, summary, day) => ({
    id, sessionId, summary, summaryTag: "summary", userContent: "", assistantContent: "", createdAt: date(day),
});

function fixture(sessions = [session("source", 1), session("target", 10)]) {
    return {
        sessions,
        kv: new Map([
            [prefix + "source", JSON.stringify([turn("source", "shared", "stale", 1), turn("source", "old", "old", 2)])],
            [prefix + "target", JSON.stringify([turn("target", "shared", "edited", 1)])],
        ]),
        fallback: new Map(),
    };
}

const modules = new Map();
for (const name of ["kv-db", "chat-storage", "chat-offline-storage"]) {
    const source = readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
    modules.set(`./${name}`, ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText);
}

function boot(disk, faults = {}) {
    const warnings = [];
    let tail = Promise.resolve();
    const enqueue = action => {
        const next = tail.then(action);
        tail = next.catch(() => {});
        return next;
    };
    // Model serialized IDB writes and transaction rollback without sharing the app cache across boots.
    const transactionScope = new AsyncLocalStorage();
    class MemoryDexie {
        version() {
            return { stores: () => {} };
        }
        entries = {
            toArray: async () => {
                if (faults.hydrate) throw new Error("KV unavailable");
                return [...disk.kv].map(([key, value]) => ({ key, value }));
            },
            bulkPut: batch => enqueue(() => {
                for (const { key, value } of batch) disk.kv.set(key, value);
            }),
            put: ({ key, value }) => this.write(key, value),
            delete: key => this.write(key, null),
        };
        apply(key, value) {
            if (value === null) disk.kv.delete(key);
            else disk.kv.set(key, value);
        }
        async write(key, value) {
            const staged = transactionScope.getStore();
            if (!staged) return enqueue(() => this.apply(key, value));
            if (faults.reject?.(key, value)) throw new Error("Write rejected");
            staged.set(key, value);
            await faults.beforeCommit?.(key, value);
        }
        transaction(_mode, _table, action) {
            return enqueue(async () => {
                const staged = new Map();
                await transactionScope.run(staged, action);
                for (const [key, value] of staged) this.apply(key, value);
            });
        }
    }
    const putSessions = sessions => {
        const byId = new Map(disk.sessions.map(item => [item.id, item]));
        for (const item of sessions) byId.set(item.id, structuredClone(item));
        disk.sessions = [...byId.values()];
    };
    const chatDb = {
        initChatDb: async () => ({ sessions: structuredClone(disk.sessions), messages: [], contacts: [] }),
        dbReplaceSessions: sessions => {
            if (!faults.sessionWrite) disk.sessions = structuredClone(sessions);
        },
        dbPutSessions: putSessions,
        chatDb: { sessions: { bulkPut: async sessions => {
            if (faults.sessionWrite) throw new Error("Session write rejected");
            putSessions(sessions);
        } } },
    };
    const stubs = new Map([
        ["dexie", MemoryDexie],
        ["./chat-db", chatDb],
        ["./character-storage", { loadCharacters: () => [] }],
        ["./llm-prompt-assembler", { formatChatTimestamp: timestamp => timestamp }],
        ...["settings-storage", "chat-plugin-hooks", "rich-message-parser", "text-tool-protocol"].map(name => [`./${name}`, {}]),
    ]);
    const localStorage = {
        get length() { return disk.fallback.size; },
        key: index => [...disk.fallback.keys()][index],
        getItem: key => disk.fallback.get(key) ?? null,
        setItem: (key, value) => disk.fallback.set(key, value),
        removeItem: key => disk.fallback.delete(key),
    };
    const loaded = new Map();
    function load(name) {
        if (stubs.has(name)) return stubs.get(name);
        if (loaded.has(name)) return loaded.get(name);
        assert.ok(modules.has(name), `Unexpected import ${name}`);
        const exports = {};
        loaded.set(name, exports);
        runInNewContext(modules.get(name), {
            require: load, exports, window: {}, localStorage, console: { warn: (...args) => warnings.push(args) },
        }, { filename: name });
        return exports;
    }
    return {
        chat: load("./chat-storage"), offline: load("./chat-offline-storage"), kv: load("./kv-db"), warnings,
        async settle() {
            // Drain DB writes plus continuations that enqueue the next migration step.
            for (let i = 0; i < 10; i++) {
                await tail;
                await new Promise(resolve => setImmediate(resolve));
            }
            await tail;
        },
    };
}

const ids = disk => disk.sessions.map(item => item.id).sort();
const turnsOnDisk = (disk, id) => JSON.parse(disk.kv.get(prefix + id));
const projected = app => Array.from(app.offline.loadChatOfflineProjectionEntries("A", { excludeSessionId: "group" }));

for (const failingKey of ["target", "source"]) {
    test(`failure on ${failingKey} leaves the source visible across refresh and retry is idempotent`, async () => {
        const disk = fixture();
        const reject = key => key === prefix + failingKey;
        let app = boot(disk, { reject });
        await app.chat.hydrateChatStorage();
        assert.deepEqual(ids(disk), ["source", "target"]);
        assert.ok(disk.kv.has(prefix + "source"));
        if (failingKey === "target") assert.equal(turnsOnDisk(disk, "target").length, 1);

        app = boot(disk, { reject });
        await app.chat.hydrateChatStorage();
        assert.ok(projected(app).some(item => item.sessionId === "source" && item.content.endsWith("] old")));
        assert.equal(app.offline.loadChatOfflineTurns("source").length, 2);
        await app.settle();

        app = boot(disk);
        await app.chat.hydrateChatStorage();
        app.chat.saveChatSessions(app.chat.loadChatSessions());
        await app.settle();
        assert.deepEqual(ids(disk), ["target"]);
        assert.ok(!disk.kv.has(prefix + "source"));
        assert.deepEqual(turnsOnDisk(disk, "target").map(({ id, summary, sessionId }) => [id, summary, sessionId]), [
            ["shared", "edited", "target"], ["old", "old", "target"],
        ]);
    });
}

test("startup migrates a source stored only in legacy localStorage", async () => {
    const disk = fixture();
    const key = prefix + "source";
    disk.fallback.set(key, disk.kv.get(key));
    disk.kv.delete(key);
    const app = boot(disk);
    await app.chat.hydrateChatStorage();
    assert.deepEqual(ids(disk), ["target"]);
    assert.ok(!disk.fallback.has(key));
    assert.deepEqual(turnsOnDisk(disk, "target").map(item => item.summary), ["edited", "old"]);
});

for (const brokenKey of ["source", "target"]) {
    test(`malformed ${brokenKey} data leaves both keys and session rows intact`, async () => {
        const disk = fixture();
        disk.kv.set(prefix + brokenKey, "{bad json");
        const before = new Map(disk.kv);
        const app = boot(disk);
        await app.chat.hydrateChatStorage();
        assert.deepEqual(ids(disk), ["source", "target"]);
        assert.deepEqual(disk.kv, before);
    });
}

test("read retries after KV hydration failure without having removed a source row", async () => {
    const disk = fixture();
    const faults = { hydrate: true };
    const app = boot(disk, faults);
    await app.chat.hydrateChatStorage();
    assert.deepEqual(ids(disk), ["source", "target"]);
    assert.ok(disk.kv.has(prefix + "source"));
    faults.hydrate = false;
    app.chat.loadChatSessions();
    await app.settle();
    assert.deepEqual(ids(disk), ["target"]);
    assert.deepEqual(turnsOnDisk(disk, "target").map(item => item.summary), ["edited", "old"]);
});

test("save defers migration when the new target session cannot be persisted", async () => {
    const disk = fixture([session("source", 1)]);
    const faults = { sessionWrite: true };
    const app = boot(disk, faults);
    await app.chat.hydrateChatStorage();
    app.chat.saveChatSessions([...app.chat.loadChatSessions(), session("target", 10)]);
    await app.settle();
    assert.deepEqual(ids(disk), ["source"]);
    assert.equal(turnsOnDisk(disk, "target").length, 1);
    assert.equal(turnsOnDisk(disk, "source").length, 2);
    faults.sessionWrite = false;
    app.chat.loadChatSessions();
    await app.settle();
    assert.deepEqual(ids(disk), ["target"]);
});

for (const saveUnrelated of [false, true]) {
    test(`concurrent source and target appends survive (session list saved: ${saveUnrelated})`, async () => {
        const disk = fixture([session("target", 10)]);
        let entered;
        const started = new Promise(resolve => { entered = resolve; });
        let resume;
        const gate = new Promise(resolve => { resume = resolve; });
        let paused = false;
        const app = boot(disk, { beforeCommit: async key => {
            if (paused || key !== prefix + "target") return;
            paused = true;
            entered();
            await gate;
        } });
        await app.chat.hydrateChatStorage();
        app.chat.saveChatSessions([session("source", 1), ...app.chat.loadChatSessions()]);
        await started;
        assert.equal(app.offline.loadChatOfflineTurns("target").length, 1);
        for (const id of ["source", "target"]) {
            app.offline.appendChatOfflineTurn({ sessionId: id, summary: `new ${id}`, summaryTag: "summary", userContent: "", assistantContent: "" });
        }
        if (saveUnrelated) app.chat.saveChatSessions([...app.chat.loadChatSessions(), session("unrelated", 5, "B")]);
        resume();
        await app.settle();
        assert.equal(disk.sessions.length, saveUnrelated ? 2 : 1);
        assert.equal(ids(disk).includes("unrelated"), saveUnrelated);
        const winner = ids(disk).find(id => id !== "unrelated");
        assert.deepEqual(turnsOnDisk(disk, winner).map(item => item.summary).sort(), ["edited", "new source", "new target", "old"]);
    });
}

 test("a failed first hop keeps the intermediate session available for retry", async () => {
    const disk = fixture([session("source", 1), session("middle", 5), session("target", 10)]);
    disk.kv.set(prefix + "middle", JSON.stringify([turn("middle", "middle", "middle", 5)]));
    const faults = { reject: key => key === prefix + "middle" };
    const app = boot(disk, faults);
    await app.chat.hydrateChatStorage();
    assert.deepEqual(ids(disk), ["middle", "source", "target"]);
    faults.reject = undefined;
    app.chat.loadChatSessions();
    await app.settle();
    assert.deepEqual(ids(disk), ["target"]);
    assert.deepEqual(turnsOnDisk(disk, "target").map(item => item.summary), ["edited", "old", "middle"]);
});
