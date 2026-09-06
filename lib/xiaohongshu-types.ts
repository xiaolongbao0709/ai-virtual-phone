import { DEFAULT_XIAOHONGSHU_BILINGUAL_PROMPT } from "./bilingual-prompt-defaults";

export type XiaohongshuTabId = "home" | "video" | "publish" | "messages" | "profile";

export type XiaohongshuAuthorType = "user" | "npc" | "character";
export type XiaohongshuNoteType = "post" | "video";
export type XiaohongshuTone = "ivory" | "mist" | "blush" | "graphite";

export type XiaohongshuComment = {
  id: string;
  noteId: string;
  authorType: XiaohongshuAuthorType;
  authorId: string;
  authorName: string;
  text: string;
  replyTo?: string;
  replyToCommentId?: string;
  likeCount: number;
  dislikeCount: number;
  liked: boolean;
  disliked: boolean;
  createdAt: string;
  unread?: boolean;
};

export type XiaohongshuNote = {
  id: string;
  type: XiaohongshuNoteType;
  feedScope?: "discover" | "nearby";
  source: XiaohongshuAuthorType;
  authorId: string;
  authorName: string;
  title: string;
  body: string;
  videoDescription?: string;
  coverIcon: string;
  tone: XiaohongshuTone;
  tags: string[];
  likeCount: number;
  saveCount: number;
  commentCount: number;
  liked: boolean;
  saved: boolean;
  recentLikeNames: string[];
  recentSaveNames: string[];
  comments: XiaohongshuComment[];
  imageAssetId?: string;
  imageAssetIds?: string[];
  imageDescription?: string;
  imageWidth?: number;
  imageHeight?: number;
  imageCompressedAt?: string;
  imageCleanedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type XiaohongshuUserProfile = {
  nickname: string;
  handle: string;
  ipLocation: string;
  signature: string;
  gender: string;
  followingCount: number;
  followerCount: number;
  likedAndSavedCount: number;
  coverImageAssetId?: string;
};

export type XiaohongshuSettings = {
  bilingualTranslationEnabled: boolean;
  collapseBilingualTranslation: boolean;
  bilingualTranslationPrompt: string;
  npcIdentityGuardPrompt: string;
  npcFeedPrompt: string;
  npcUserPostReactionPrompt: string;
  npcCommentReplyPrompt: string;
  npcMoreCommentsPrompt: string;
  npcDmReplyPrompt: string;
  participantCharacterIds: string[];
  sendToCharacterProbability: number;
};

export type XiaohongshuNotificationType = "like" | "save" | "comment" | "dm" | "follow";

export type XiaohongshuNotification = {
  id: string;
  type: XiaohongshuNotificationType;
  noteId?: string;
  actorName: string;
  text: string;
  count?: number;
  thumbnailText?: string;
  direction?: "incoming" | "outgoing";
  threadId?: string;
  threadName?: string;
  unread: boolean;
  createdAt: string;
};

export type XiaohongshuDraftImage = {
  assetId?: string;
  dataUrl?: string;
  description?: string;
  width?: number;
  height?: number;
};

export type XiaohongshuUserPostInput = {
  title: string;
  body: string;
  tags: string[];
  image?: XiaohongshuDraftImage;
  images?: XiaohongshuDraftImage[];
};

export type XiaohongshuUserInteractions = {
  likedNoteIds: string[];
  savedNoteIds: string[];
  commentedNoteIds: string[];
};

export type XiaohongshuAccount = {
  type: XiaohongshuAuthorType;
  id: string;
  name: string;
  avatar?: string;
  followedAt: string;
};

export type XiaohongshuSocialGraph = {
  following: XiaohongshuAccount[];
  followers: XiaohongshuAccount[];
};

export type XiaohongshuState = {
  profile: XiaohongshuUserProfile;
  settings: XiaohongshuSettings;
  notes: XiaohongshuNote[];
  feedHiddenNoteIds: string[];
  notifications: XiaohongshuNotification[];
  userInteractions: XiaohongshuUserInteractions;
  socialGraph: XiaohongshuSocialGraph;
  updatedAt: string;
};

export type ParsedXiaohongshuNpcFeed = {
  homeNotes: XiaohongshuNote[];
  videoNotes: XiaohongshuNote[];
  nearbyNotes: XiaohongshuNote[];
};

export type ParsedXiaohongshuNpcReaction = {
  likeCount: number;
  saveCount: number;
  recentLikeNames: string[];
  recentSaveNames: string[];
  comments: Array<Pick<XiaohongshuComment, "authorName" | "text" | "replyTo" | "replyToCommentId">>;
  directMessages: Array<{ name: string; text: string }>;
  followerNames: string[];
};

export type ParsedXiaohongshuCharacterThreadItem = {
  /** 原始延伸编号，用于保持 "延伸N" 引用关系 */
  number: number;
  /** 延伸评论作者名；如果与角色名或小红书显示名一致，apply 时识别为 character，否则为 npc */
  authorName: string;
  text: string;
  /** 引用目标：字符串 "主评论" 表示挂在角色主评论下；"延伸N" 表示挂在前面的延伸评论下；缺省默认为主评论 */
  replyTo?: string;
};

export type ParsedXiaohongshuCharacterActivity = {
  comments: Array<{
    noteId: string;
    text: string;
    liked: boolean;
    saved: boolean;
    thread?: ParsedXiaohongshuCharacterThreadItem[];
  }>;
  post?: {
    type: XiaohongshuNoteType;
    title: string;
    body: string;
    coverIcon: string;
    tags: string[];
    likeCount: number;
    saveCount: number;
    commentCount: number;
    recentLikeNames: string[];
    recentSaveNames: string[];
    imageDescription?: string;
    videoDescription?: string;
    comments: Array<Pick<XiaohongshuComment, "authorName" | "text" | "replyTo" | "replyToCommentId">>;
  };
};

export type ParsedXiaohongshuCharacterReaction = {
  comment: string;
  liked: boolean;
  saved: boolean;
  followedAuthor: boolean;
  thread?: ParsedXiaohongshuCharacterThreadItem[];
};

export type ParsedXiaohongshuCharacterMentionReply = {
  comment: string;
  thread?: ParsedXiaohongshuCharacterThreadItem[];
};

export type ParsedXiaohongshuNpcCommentReply = {
  comments: Array<Pick<XiaohongshuComment, "authorName" | "text" | "replyTo" | "replyToCommentId">>;
};

export type ParsedXiaohongshuNpcDmReply = {
  messages: string[];
};

export const DEFAULT_XIAOHONGSHU_PROFILE: XiaohongshuUserProfile = {
  nickname: "我",
  handle: "rednote_user",
  ipLocation: "未知",
  signature: "记录一点日常。",
  gender: "♀",
  followingCount: 0,
  followerCount: 0,
  likedAndSavedCount: 0,
};

export const DEFAULT_XIAOHONGSHU_NPC_IDENTITY_GUARD_PROMPT = [
  "<xiaohongshu_npc_identity_guard>",
  "以下名字属于真实角色或用户，NPC 严禁冒用这些名字作为笔记作者、评论作者、回复作者、点赞/收藏/关注昵称或私信发送者：",
  "{{xiaohongshuReservedNames}}",
  "如果需要普通路人，请自创与上述名单不相同、不近似的昵称。",
  "</xiaohongshu_npc_identity_guard>",
].join("\n");

export const DEFAULT_XIAOHONGSHU_NPC_FEED_PROMPT = [
  "你正在生成一个仿小红书首页内容流。",
  "请输出 6 条 #首页笔记、6 条 #视频笔记、4 条 #附近笔记，每条都要像真实小红书陌生网友内容。",
  "内容可以是生活分享、吐槽、求助、种草、城市日常、情绪记录、教程、穿搭、美食、学习、工作、旅行等。",
  "如果上下文给出用户关注的账号，可以适当提高这些账号再次出现的概率，但不要每次都出现。",
  "如果上下文给出 [用户IP属地]，#附近笔记 需要围绕该属地或同城/附近城市生成本地生活、同城吐槽、附近求助、城市日常等内容。",
  "每条笔记要包含点赞数、收藏数、评论数和 3 到 8 条评论；输出的评论只是评论区样例，不代表全部评论。",
  "如需楼中楼，使用 [评论N回复对象]评论M，其中 M 必须是前面已经出现过的评论编号。",
  "楼中楼示例：评论2回复评论1时，必须写 [评论2回复对象]评论1，不要写昵称、评论ID或其他文字。",
  "",
  "活人感要求：",
  "- 笔记以碎片化、去精致化的日常分享为主，标题正文口语化、可用网络黑话/表情/不完整句，不煽情、不装逼、不写小作文；多种形式并存（吐槽、疑问、求助、种草、踩雷、晒图、碎碎念等）。",
  "- *绝对禁止讲大道理、爹味说教、强行把日常上升高度*，内容落于实际、轻松幽默。",
  "- 评论区禁止一边倒夸作者；NPC不脸谱化，多种性格并存（尖锐的、温和的、挑事的、看戏的、蹲后续的、跑题的、抬杠的、求链接的），可体现不同观点甚至轻微争执。",
  "- *绝对禁止“引用正文/评论原文+这句太真实了/说到我心趴上了”这种格式*。",
  "",
  "输出格式：",
  "#首页笔记1",
  "[作者]昵称",
  "[标题]标题",
  "[正文]正文",
  "[图标]单个 emoji 或符号",
  "[点赞]数字",
  "[收藏]数字",
  "[评论数]数字",
  "[标签]标签1、标签2",
  "[评论1作者]昵称",
  "[评论1内容]评论内容",
  "[评论2作者]昵称",
  "[评论2回复对象]评论1",
  "[评论2内容]回复评论1的楼中楼内容",
  "",
  "#视频笔记1",
  "[作者]昵称",
  "[标题]标题",
  "[正文]发布文案",
  "[视频描述]视频画面描述",
  "[图标]单个 emoji 或符号",
  "[点赞]数字",
  "[收藏]数字",
  "[评论数]数字",
  "[标签]标签1、标签2",
  "[评论1作者]昵称",
  "[评论1内容]评论内容",
  "[评论2作者]昵称",
  "[评论2回复对象]评论1",
  "[评论2内容]回复评论1的楼中楼内容",
  "",
  "#附近笔记1",
  "[作者]昵称",
  "[标题]标题",
  "[正文]同城/附近相关正文",
  "[图标]单个 emoji 或符号",
  "[点赞]数字",
  "[收藏]数字",
  "[评论数]数字",
  "[标签]标签1、标签2",
  "[评论1作者]昵称",
  "[评论1内容]评论内容",
  "[评论2作者]昵称",
  "[评论2回复对象]评论1",
  "[评论2内容]回复评论1的楼中楼内容",
].join("\n");

export const DEFAULT_XIAOHONGSHU_NPC_USER_POST_REACTION_PROMPT = [
  "你正在模拟小红书陌生网友对用户刚发布笔记的互动。",
  "根据用户笔记内容、TAG、图片内容、已有评论，生成自然的平台互动。",
  "需要输出点赞数、收藏数、前两个点赞昵称、前两个收藏昵称、评论、新增关注和私信。",
  "如果这条笔记可能吸引新粉丝，请输出 [新增关注]数字 和 [关注用户N]昵称；如果没有新增关注，可以填 0 或省略。",
  "All generated comments and replies must come from NPC Xiaohongshu strangers, not from the post author.",
  "The post author must never appear as a generated commenter, replier, liker, saver, follower, or private-message sender.",
  "Do not use the user's nickname, Xiaohongshu ID, profile name, configured persona name, or wording such as \"楼主\", \"本人\", or \"我自己\" to imply the user is interacting with their own note.",
  "绝对禁止以{{user}}身份评论、回复。",
  "评论可以包含楼中楼；如需楼中楼，使用 [评论N回复对象]评论M。",
  "楼中楼示例：评论2回复评论1时，必须写 [评论2回复对象]评论1，不要写昵称、评论ID或其他文字。",
  "",
  "活人感要求：",
  "- 评论要短、口语化，像随手一打的真实评论，可用黑话/表情/不完整句；不煽情、不装逼、不写小作文。",
  "- 评论落到具体的图/正文/TAG细节或真实反应（吐槽、好奇、共鸣、调侃、提问、求链接、踩雷提醒），*绝对禁止讲大道理、爹味说教、强行升华或客服式总结*。",
  "- 评论区禁止一边倒夸楼主；NPC不脸谱化，多种性格并存（尖锐/温和/挑事/看戏/蹲后续/抬杠/跑题），可有不同观点甚至轻微争执。",
  "- *绝对禁止“引用笔记原文+这句太真实了”这种格式*。",
  "- 私信也要口语自然，别像客服或营销号。",
  "",
  "输出格式：",
  "#用户笔记互动",
  "[点赞]数字",
  "[点赞用户1]昵称",
  "[点赞用户2]昵称",
  "[收藏]数字",
  "[收藏用户1]昵称",
  "[收藏用户2]昵称",
  "[新增关注]数字",
  "[关注用户1]昵称",
  "[关注用户2]昵称",
  "",
  "[评论1作者]昵称",
  "[评论1内容]评论内容",
  "[评论2作者]昵称",
  "[评论2回复对象]评论1",
  "[评论2内容]楼中楼回复内容",
  "",
  "#私信1",
  "[名称]昵称",
  "[正文]私信内容",
].join("\n");

export const DEFAULT_XIAOHONGSHU_NPC_COMMENT_REPLY_PROMPT = [
  "你正在模拟小红书陌生网友在一条笔记评论区里继续接话。",
  "根据笔记内容、用户刚发的评论/回复、被回复评论和已有评论，生成自然的评论区回复。",
  "回复可以来自被评论的人，也可以来自其他路人；如果不适合回复，可以只输出 1 条。",
  "绝对禁止以{{user}}身份评论、回复。",
  "如需楼中楼，使用 [评论N回复评论ID]填写上下文里给出的评论ID。",
  "评论ID 示例：如果上下文里有 [评论ID]某条真实评论ID，回复这条评论时就写 [评论1回复评论ID]某条真实评论ID。",
  "不要填写“评论1”、昵称、“被回复评论ID”、“候选评论ID”等占位文字；必须完整复制上下文里的真实 [评论ID]。",
  "",
  "活人感要求：",
  "- 回复像真实评论区接话，短、口语、就事论事，可用黑话/表情/梗；不写小作文、不煽情、不装逼。",
  "- 接住对方的具体那句话自然往下聊（调侃、反问、附和、轻怼、跑题），*绝对禁止说教、爹味、强行升华或客服式回应*。",
  "- 多条回复之间性格各异、可有不同观点甚至拌嘴，禁止集体吹捧楼主或某一方。",
  "- *绝对禁止“引用对方原话+这句太真实了”这种格式*。",
  "",
  "输出格式：",
  "#评论回复",
  "[评论1作者]昵称",
  "[评论1回复评论ID]从上下文复制的真实评论ID",
  "[评论1内容]回复内容",
  "",
  "[评论2作者]昵称",
  "[评论2回复评论ID]从上下文复制的真实评论ID",
  "[评论2内容]回复内容",
].join("\n");

export const DEFAULT_XIAOHONGSHU_NPC_MORE_COMMENTS_PROMPT = [
  "你正在模拟小红书陌生网友继续参与一条笔记的评论区讨论。",
  "根据笔记标题、正文、TAG、图片内容、互动数据和已有评论，生成 4 到 8 条新的自然评论。",
  "这些评论可以是普通评论，也可以是楼中楼回复；需要像真实小红书评论区，不要像机器人总结。",
  "绝对禁止以{{user}}身份评论、回复。",
  "如果回复本次新生成的前面评论，使用 [评论N回复对象]评论M，其中 M 必须是前面已经出现过的本次评论编号。",
  "如果回复已有评论，使用 [评论N回复评论ID]完整复制上下文里的真实 [评论ID]。",
  "楼中楼示例：评论2回复本次评论1时，写 [评论2回复对象]评论1；回复已有评论时，写 [评论2回复评论ID]从上下文复制的真实评论ID。",
  "",
  "活人感要求：",
  "- 评论短、口语化、就事论事，可用黑话/表情/梗；不写小作文、不煽情、不装逼，别像机器人总结。",
  "- NPC多种性格并存（尖锐/温和/挑事/看戏/蹲后续/抬杠/跑题/求链接），禁止一边倒夸楼主，可有不同观点甚至拌嘴。",
  "- 评论落到笔记/已有评论的具体点，*绝对禁止讲大道理、爹味说教、强行升华*。",
  "- *绝对禁止“引用原文+这句太真实了”这种格式*。",
  "",
  "输出格式：",
  "#更多评论",
  "[评论1作者]昵称",
  "[评论1内容]评论内容",
  "[评论2作者]昵称",
  "[评论2回复对象]评论1",
  "[评论2内容]回复评论1的楼中楼内容",
  "[评论3作者]昵称",
  "[评论3回复评论ID]从上下文复制的真实评论ID",
  "[评论3内容]回复已有评论的楼中楼内容",
].join("\n");

export const DEFAULT_XIAOHONGSHU_NPC_DM_REPLY_PROMPT = [
  "你正在模拟小红书私信里的陌生网友回复用户。",
  "根据对话对象、用户刚发的私信、历史私信和相关笔记信息，生成自然的私信回复。",
  "可以连续回复 1 到 4 条消息；每条消息要像真实聊天，可以短句、口语、带 emoji，也可以分多条发。",
  "不要替用户说话，不要输出系统解释，不要输出 Markdown。",
  "别客服腔、别营销号腔，符合这个陌生网友的身份和性格，自然像真人私聊。",
  "",
  "输出格式：",
  "#私信回复1",
  "[正文]回复内容",
  "",
  "#私信回复2",
  "[正文]第二条回复内容",
].join("\n");

export const DEFAULT_XIAOHONGSHU_SETTINGS: XiaohongshuSettings = {
  bilingualTranslationEnabled: true,
  collapseBilingualTranslation: true,
  bilingualTranslationPrompt: DEFAULT_XIAOHONGSHU_BILINGUAL_PROMPT,
  npcIdentityGuardPrompt: DEFAULT_XIAOHONGSHU_NPC_IDENTITY_GUARD_PROMPT,
  npcFeedPrompt: DEFAULT_XIAOHONGSHU_NPC_FEED_PROMPT,
  npcUserPostReactionPrompt: DEFAULT_XIAOHONGSHU_NPC_USER_POST_REACTION_PROMPT,
  npcCommentReplyPrompt: DEFAULT_XIAOHONGSHU_NPC_COMMENT_REPLY_PROMPT,
  npcMoreCommentsPrompt: DEFAULT_XIAOHONGSHU_NPC_MORE_COMMENTS_PROMPT,
  npcDmReplyPrompt: DEFAULT_XIAOHONGSHU_NPC_DM_REPLY_PROMPT,
  participantCharacterIds: [],
  sendToCharacterProbability: 60,
};
