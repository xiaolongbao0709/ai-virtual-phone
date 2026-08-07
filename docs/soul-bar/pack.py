import zipfile, os

app = os.path.join(os.path.dirname(__file__), 'app')
out = os.path.join(os.path.dirname(__file__), 'soul-bar-app-10.zip')
files = ['manifest.json', 'index.html', 'icon.png', 'presets.json']

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        p = os.path.join(app, f)
        if not os.path.exists(p):
            raise SystemExit('缺少文件: ' + p)
        z.write(p, f)  # 平铺到 ZIP 根目录

print('已写出', out, os.path.getsize(out), 'bytes')
with zipfile.ZipFile(out) as z:
    print('ZIP 内容(应全部在根目录，无 app/ 前缀):', z.namelist())
    bad = [n for n in z.namelist() if n.startswith('app/') or '/' in n.replace('manifest.json','').replace('index.html','').replace('icon.png','').replace('presets.json','')]
    if bad:
        raise SystemExit('发现非根目录条目: ' + str(bad))
    print('✅ 所有文件均平铺在 ZIP 根目录')
