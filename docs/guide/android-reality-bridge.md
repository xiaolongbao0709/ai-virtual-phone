# 安卓端联动「现实桥」(Reality Bridge) 配置指南

虽然系统内置功能名为「iOS 现实桥」，但安卓用户同样可以通过自动化工具（如 MacroDroid、Tasker）利用 Webhook 管道实现现实世界与 AI 虚拟手机的联动。

本指南以 **MacroDroid（免费版）** 为例，介绍如何同步电量、通知和地理位置。

## 准备工作

1. **安装工具**：在安卓手机下载 [MacroDroid](https://play.google.com/store/apps/details?id=com.arlosoft.macrodroid)。
2. **获取凭据**（仅限自部署用户）：
   - 进入小手机内置「现实桥」->「配置教程」。
   - 记录 **Webhook URL**（Supabase 存储桶路径）。
   - 记录 **Authorization 密钥** (Bearer Token)。

## 核心配置逻辑

所有的联动都遵循：**触发器 (Trigger) -> HTTP 请求 (Action)**。

### 1. 基础配置：HTTP 请求模板
在 MacroDroid 中添加动作「HTTP 请求」，通用设置如下：
- **方法**: POST
- **URL**: `https://<项目ID>.supabase.co/storage/v1/object/ai-phone-backup/bridge-inbox/<文件名>.json`
  - *提示：建议文件名包含时间变量 `[date_hour][date_minute][date_second]` 以防重名覆盖。*
- **内容类型**: `application/json`
- **请求头部**: 
  - Key: `Authorization`
  - Value: `Bearer <你的完整Token>`

---

## 场景配置示例

### 场景一：同步手机电量
- **触发器**: 电池/电源 -> 电量改变 -> 任意改变（或设置步进，如每 5%）。
- **请求正文 (JSON)**:
```json
{
  "type": "android_update",
  "payload": {
    "battery": "[battery]"
  }
}
```

### 场景二：同步实时通知 (微信/短信)
- **触发器**: 通知 -> 通知收到 -> 选择应用（建议仅勾选社交软件）。
- **请求正文 (JSON)**:
```json
{
  "type": "android_notification",
  "payload": {
    "app": "[notification_package_name]",
    "title": "[notification_title]",
    "text": "[notification_main_text]"
  }
}
```

### 场景三：地理围栏 (回家/出门)
- **触发器**: 位置 -> 地理围栏事件 -> 进入/离开区域（需先在 MacroDroid 定义「家」的位置）。
- **请求正文 (JSON)**:
```json
// 进入区域
{
  "type": "android_location",
  "payload": { "atHome": true, "loc": "家" }
}
// 离开区域
{
  "type": "android_location",
  "payload": { "atHome": false, "loc": "外面" }
}
```

## 注意事项
- **流量配额**：Supabase 免费版有 2GB 流量限制。请避免监听所有系统的频繁通知，建议对电量触发设置步进。
- **后台运行**：请在系统设置中允许 MacroDroid 「忽略电池优化」并开启「自启动」，以确保信号实时送达。
- **隐私**：同步通知意味着 AI 将读取你的部分现实消息内容，请在 MacroDroid 中合理设置应用白名单。
