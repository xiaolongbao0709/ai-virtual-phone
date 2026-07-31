import type { CustomAppManifest, CustomAppPermission } from "./custom-app-types";

export type CustomAppReviewStatus = "pending" | "approved" | "rejected";

export type CustomAppPackageKind = "floatapp" | "zip" | "html";

export type CustomAppMarketItem = {
  id: string;
  appId: string;
  name: string;
  version: string;
  changelog?: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  description?: string;
  iconDataUrl?: string;
  permissions: CustomAppPermission[];
  manifest: CustomAppManifest;
  packageUrl: string;
  /** 包内容 SHA-256（服务端计算，用于防原样重传倒卖；旧数据可能为空） */
  packageHash?: string;
  packagePath: string;
  packageKind: CustomAppPackageKind;
  packageSize: number;
  reviewStatus: CustomAppReviewStatus;
  installCount: number;
  likeCount: number;
  createdAt: string;
  updatedAt: string;
};
