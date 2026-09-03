export type User = {
  id: number;
  username: string;
  /** 对外展示的名字（个人空间里改的），可空；日志/记录一律还是 username */
  display_name: string | null;
  /** data/avatars/ 下的头像文件名，可空 */
  avatar_filename: string | null;
  created_at: string;
};

/** 图库中的一张图片（素材） */
export type Asset = {
  id: number;
  owner_id: number;
  filename: string;
  thumb_filename: string | null;
  original_name: string | null;
  mime_type: string;
  width: number | null;
  height: number | null;
  size_bytes: number;
  title: string | null;
  /** 预留：X API 采集器写入 */
  source_url: string | null;
  source_author: string | null;
  source_post_id: string | null;
  /** private: 仅自己可见；shared: 所有登录用户可见（共享图库） */
  visibility: 'private' | 'shared';
  /** 软删除时间（非空 = 在回收站里），恢复时置回 NULL */
  deleted_at?: string | null;
  created_at: string;
  /** 联表查询时附带：素材上传者 */
  owner_username?: string;
};

export type SpaceVisibility = 'private' | 'public';

export type Space = {
  id: number;
  owner_id: number;
  name: string;
  description: string | null;
  visibility: SpaceVisibility;
  created_at: string;
  updated_at: string;
  lp_groups?: string | null;
  lp_phrases?: string | null;
  /** 嵌字分组样式预设（JSON：{[groupId]: LpStyle}） */
  lp_styles?: string | null;
};

/** owner 可增删改并管理成员；editor 可增删改；viewer 只读 */
export type SpaceRole = 'owner' | 'editor' | 'viewer';

export type SpaceMember = {
  id: number;
  space_id: number;
  user_id: number;
  role: SpaceRole;
  created_at: string;
  /** 联表查询时附带 */
  username?: string;
};

export type SpaceAccess = {
  role: SpaceRole;
  /** 通过成员表或所有权获得权限；公开空间的旁观者为 false */
  isMember: boolean;
  canEdit: boolean;
  /** 仅 owner：管理成员、修改空间信息、删除空间 */
  canManage: boolean;
};

/** 空间内的一张图片，带有在该空间内的命名 */
export type SpaceItem = {
  id: number;
  space_id: number;
  asset_id: number;
  title: string | null;
  sort_order: number;
  created_at: string;
  /** 联表查询时附带 */
  asset?: Asset;
  annotation_count?: number;
  /** AI 图像解析出的内容描述（人物/场景/剧情提示），AI 翻译时作为上下文 */
  ai_context?: string | null;
};

export type AnnotationKind = 'box' | 'pin';

export type LabelPlusGroup = { id: number; name: string };

/** 框选标注或 LabelPlus 点标号。坐标均为相对图片宽高的归一化值（0~1） */
export type Annotation = {
  id: number;
  item_id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** 字号 = font_size_ratio * 图片高度（像素） */
  font_size_ratio: number;
  color: string;
  bg_color: string;
  align: 'left' | 'center' | 'right';
  font_weight: number;
  order_index: number;
  kind: AnnotationKind;
  /** LabelPlus 分组 1–9；框选可忽略 */
  group_id: number;
  source_text: string;
  comment: string;
  /** 富文本分段 JSON 字符串（null = 单段继承标注级样式）；text 为纯文本冗余 */
  runs?: string | null;
  /** 文字不透明度 0~1（默认 1） */
  text_opacity?: number | null;
  /** 疑点标记（库里存 0/1，前端归一化为 boolean） */
  doubtful?: boolean;
  updated_by: number | null;
  updated_by_username?: string | null;
};

export type SpaceWithCounts = Space & {
  item_count: number;
  annotation_count: number;
  cover_item_id: number | null;
  /** 封面缩略图，用于列表卡片展示 */
  cover_thumb: string | null;
  cover_filename: string | null;
  member_count: number;
  /** 文件夹创建者用户名（开放空间模型下用于卡片展示） */
  owner_name?: string | null;
  /** 当前用户在该空间的角色 */
  role: SpaceRole;
  can_edit: boolean;
  is_owner: boolean;
};
