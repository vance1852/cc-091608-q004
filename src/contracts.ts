export type RescueState = "asking-wearer" | "contacting" | "emergency" | "resolved";

export interface FallSignal {
  eventId: string;
  wearerId: string;
  capturedAt: string;
  receivedAt: string;
  impactG: number;
  postureChanged: boolean;
  stillSeconds: number;
  worn: boolean;
  locationToken?: string;
}

export interface ContactRule {
  contactId: string;
  priority: number;
  quietHours?: { from: string; to: string };
  channels: Array<"voice" | "sms" | "app">;
}

export interface RescueTimelineEntry {
  entryId: string;
  rescueId: string;
  state: RescueState;
  actorId: string;
  reason: string;
  occurredAt: string;
}
