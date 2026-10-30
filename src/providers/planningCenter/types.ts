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
