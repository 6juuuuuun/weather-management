export type Kind = "rain"|"snow"|"wind"|"heat";
export type Grade = "watch"|"warning";
export type Status = "PENDING_APPROVAL"|"ACTIVE"|"RESOLVED"|"ESCALATED"|"DISMISSED";

export type Obs = { rain: number|null; snowNew: number|null; snowToday: number|null;
  rainToday: number|null; temp: number|null; feels: number|null; wind: number|null };

export type Criterion = { kind: Kind; grade: Grade; threshold: Record<string, number> };
export type AlertSetting = { kind: Kind; enabled: boolean;
  repeatPolicy: "once"|"hourly_until_below"|"until_daily_accum_below";
  repeatAccumThreshold: number|null; heatRepeatBasis: "temp"|"feels"|null };
export type OpenEvent = { id: string; kind: Kind; grade: Grade; status: Status;
  dismissedOpen?: boolean };

export type Action =
  | { type: "create"; kind: Kind; grade: Grade }
  | { type: "escalate"; eventId: string; kind: Kind }
  | { type: "repeat"; eventId: string; kind: Kind; grade: Grade }
  | { type: "resolve"; eventId: string; kind: Kind; grade: Grade };
