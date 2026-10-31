/** Provider-shaped JSON:API envelopes. Kept separate from the app's internal models. */
export interface PcoResource<A = Record<string, unknown>> {
  type: string;
  id: string;
  attributes: A;
  relationships?: Record<string, { data: { type: string; id: string } | { type: string; id: string }[] | null }>;
  links?: Record<string, string | null>;
}

export interface PcoListResponse<A> {
  data: PcoResource<A>[];
  included?: PcoResource[];
  links?: { self?: string; next?: string | null; prev?: string | null };
  meta?: { total_count?: number; count?: number; next?: { offset: number } };
}

export interface PcoSingleResponse<A> {
  data: PcoResource<A>;
  included?: PcoResource[];
}

export interface PcoPersonAttributes {
  first_name: string | null;
  last_name: string | null;
  nickname: string | null;
  name: string | null;
}

export interface PcoEmailAttributes {
  address: string;
  location: string | null;
  primary: boolean;
}

export interface PcoPhoneNumberAttributes {
  number: string;
  e164: string | null;
  location: string | null;
  primary: boolean;
}

export interface PcoHouseholdAttributes {
  name: string | null;
  member_count: number | null;
  primary_contact_id: string | null;
}

export interface PcoScheduleAttributes {
  sort_date: string | null;
  dates: string | null;
  status: string | null;
  decline_reason: string | null;
  service_type_name: string | null;
  team_name: string | null;
  team_position_name: string | null;
}

export interface PcoServiceTypeAttributes {
  name: string;
  archived_at: string | null;
  deleted_at: string | null;
}

export interface PcoPlanAttributes {
  title: string | null;
  series_title: string | null;
  dates: string | null;
  sort_date: string | null;
}

export interface PcoPlanPersonAttributes {
  name: string | null;
  status: string | null;
  team_position_name: string | null;
  decline_reason: string | null;
}

export interface PcoTeamAttributes {
  name: string | null;
}

export interface PcoGroupEventAttributes {
  name: string | null;
  starts_at: string;
  ends_at: string | null;
  canceled: boolean;
}

export interface PcoGroupAttributes {
  name: string | null;
}

export interface PcoAttendanceAttributes {
  attended: boolean;
  role: string | null;
}
