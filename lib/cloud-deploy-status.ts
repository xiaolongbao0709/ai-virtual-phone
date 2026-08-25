// 云服务部署的本机状态标记：三处入口（微信接入 / 离线推送 / 数据管理）
// 只显示"已部署/未部署 + 一个按钮"，不再各自铺开表单。
// 微信云函数没有可靠的远端探测接口，以「中央流程部署成功时打标 + 云端
// 心跳」双信号判断；轮询开关同理记录最后一次成功设置的状态。

import { kvGet, kvSet } from "./kv-db";

const WEIXIN_DEPLOYED_KEY = "ai_phone_weixin_cloud_deployed_v1";
const WEIXIN_SCHEDULED_KEY = "ai_phone_weixin_cloud_scheduled_v1";

export function markWeixinCloudDeployed(): void {
    kvSet(WEIXIN_DEPLOYED_KEY, new Date().toISOString());
}

export function getWeixinCloudDeployedAt(): string | null {
    return kvGet(WEIXIN_DEPLOYED_KEY);
}

export function saveWeixinCloudScheduled(on: boolean): void {
    kvSet(WEIXIN_SCHEDULED_KEY, on ? "1" : "0");
}

export function loadWeixinCloudScheduled(): boolean {
    return kvGet(WEIXIN_SCHEDULED_KEY) === "1";
}

const PUSH_SCHEDULED_KEY = "ai_phone_push_cloud_scheduled_v1";

export function savePushCloudScheduled(on: boolean): void {
    kvSet(PUSH_SCHEDULED_KEY, on ? "1" : "0");
}

/** 部署脚本默认就带定时任务，所以缺省视为开。 */
export function loadPushCloudScheduled(): boolean {
    return kvGet(PUSH_SCHEDULED_KEY) !== "0";
}
