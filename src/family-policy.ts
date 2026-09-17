import type { ContactRule } from "./contracts.js";

/**
 * 家属整理好的联系人策略：顺序（priority 升序）、静默时段与可用渠道。
 * 静默时段只压制非紧急通知；升级到急救后不再受其限制。
 */
export const FAMILY_CONTACTS: readonly ContactRule[] = [
  {
    contactId: "daughter",
    priority: 1,
    // 夜间 23:00-07:00 静默；跨午夜。
    quietHours: { from: "23:00", to: "07:00" },
    channels: ["voice", "app", "sms"],
  },
  {
    contactId: "son",
    priority: 2,
    quietHours: { from: "00:00", to: "06:00" },
    channels: ["voice", "sms"],
  },
  {
    // 同住小区的备用联系人，白天夜间均可接听。
    contactId: "neighbor",
    priority: 3,
    channels: ["voice"],
  },
];

/** 家属与佩戴者所在地时区（fixture 时间戳为 +08:00）。 */
export const FAMILY_TIME_ZONE = "Asia/Shanghai";
