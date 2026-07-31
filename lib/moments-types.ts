// lib/moments-types.ts
// Type definitions for the Moments (朋友圈) feature.

export type MomentPost = {
    id: string;                     // "moment_timestamp_random"
    authorType: "user" | "character";
    authorId: string;               // characterId or "user"
    content: string;
    photoUrl?: string;              // user-uploaded base64 image
    photoDescription?: string;      // AI-generated photo description (for placeholder rendering)
    photoUseReferenceImage?: boolean; // AI-generated photo should use character reference image
    photoGenerationStatus?: "pending" | "failed" | "generated";
    photoGenerationPrompt?: string;
    photoGenerationError?: string;
    photoCompressedAt?: string;
    photoCleanedAt?: string;
    visibility: string[];           // characterId[] of who can see this post
    location?: string;              // 用户添加的地点
    likes: MomentLike[];
    createdAt: string;              // ISO date string
};

export type MomentLike = {
    authorType: "user" | "character" | "npc";
    authorId: string;
    authorName?: string;            // display name for NPC (no characterId)
    createdAt: string;
};

export type MomentComment = {
    id: string;                     // "mc_timestamp_random"
    postId: string;
    authorType: "user" | "character" | "npc";
    authorId: string;
    authorName?: string;            // display name for NPC (no characterId)
    content: string;
    replyToCommentId?: string;
    replyToAuthorId?: string;       // stored for display convenience ("回复 XXX")
    replyToAuthorType?: "user" | "character" | "npc";
    replyToAuthorName?: string;     // display name of the replied-to author (for NPC)
    createdAt: string;
};

export type AIMomentSchedule = {
    characterId: string;
    lastPostTime: number;           // timestamp ms
    nextPostAfter: number;          // timestamp ms (randomized interval)
};

export type PendingReaction = {
    id: string;
    type: "npc_reaction" | "ai_comment" | "character_reply" | "npc_reply";
    postId: string;
    characterId: string;
    fireAt: number;                   // 触发时间戳 ms
    triggeringCommentIds?: string[];   // character_reply 专用
    targetNpcName?: string;            // npc_reply 专用
};
