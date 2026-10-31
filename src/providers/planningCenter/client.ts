import { providerFetch, type HttpDeps, defaultHttpDeps, ProviderHttpError, ProviderNetworkError } from "../http.ts";
import { PCO_BASE } from "./oauth.ts";
import { PcoError, toPcoError } from "./errors.ts";
import type { PcoListResponse, PcoResource, PcoSingleResponse } from "./types.ts";

/** Supplies a valid access token; `forceRefresh` after the API reports it expired. */
export type TokenProvider = (opts?: { forceRefresh?: boolean }) => Promise<string>;

/**
 * Thin read client for the Planning Center JSON:API. Provider-shaped data stays in here;
 * callers map it to internal models.
 */
export class PcoClient {
  constructor(
    private readonly getToken: TokenProvider,
    private readonly userAgent: string,
    private readonly deps: HttpDeps = defaultHttpDeps,
  ) {}

  async get<T = unknown>(pathOrUrl: string, query?: Record<string, string>): Promise<T> {
    const url = this.resolve(pathOrUrl, query);
    try {
      return await this.send<T>(url, await this.getToken());
    } catch (err) {
      const e = asPcoError(err);
      // A 401 without a recognized hint is treated like an expired token: live Planning Center
      // answers a removed app with a bare 401, not CAPUCHIN. A refused refresh marks needs_reauth.
      if (!(e instanceof PcoError) || (e.kind !== "expired_token" && e.kind !== "unauthorized")) throw e;
      return this.send<T>(url, await this.getToken({ forceRefresh: true })).catch((e2) => {
        const e3 = asPcoError(e2);
        // Freshly refreshed token still rejected: the grant is gone, so a person must reconnect.
        if (e3 instanceof PcoError && e3.kind === "unauthorized") throw new PcoError("revoked_token", e3.message, e3.status);
        throw e3;
      });
    }
  }

  getOne<A>(path: string, query?: Record<string, string>) {
    return this.get<PcoSingleResponse<A>>(path, query);
  }

  /** Follows `links.next` (offset pagination, max 100/page). `maxPages` bounds runaway loops. */
  async *paginate<A>(path: string, query: Record<string, string> = {}, maxPages = 500): AsyncGenerator<PcoResource<A>> {
    let next: string | undefined = this.resolve(path, { per_page: "100", ...query });
    for (let page = 0; next; page++) {
      if (page >= maxPages) throw new PcoError("unknown", `Stopped after ${maxPages} pages of ${path}`);
      const res: PcoListResponse<A> = await this.get<PcoListResponse<A>>(next);
      for (const item of res.data) yield item;
      next = res.links?.next ?? undefined;
    }
  }

  async listAll<A>(path: string, query?: Record<string, string>, maxPages?: number): Promise<PcoResource<A>[]> {
    const out: PcoResource<A>[] = [];
    for await (const r of this.paginate<A>(path, query, maxPages)) out.push(r);
    return out;
  }

  /** Like listAll, but also keeps each page's `included` resources (for `include=`). */
  async listAllWithIncluded<A>(path: string, query: Record<string, string> = {}, maxPages = 500): Promise<{ data: PcoResource<A>[]; included: PcoResource[] }> {
    const data: PcoResource<A>[] = [];
    const included: PcoResource[] = [];
    let next: string | undefined = this.resolve(path, { per_page: "100", ...query });
    for (let page = 0; next; page++) {
      if (page >= maxPages) throw new PcoError("unknown", `Stopped after ${maxPages} pages of ${path}`);
      const res: PcoListResponse<A> = await this.get<PcoListResponse<A>>(next);
      data.push(...res.data);
      included.push(...(res.included ?? []));
      next = res.links?.next ?? undefined;
    }
    return { data, included };
  }

  private async send<T>(url: string, token: string): Promise<T> {
    const res = await providerFetch(
      { url, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": this.userAgent } },
      this.deps,
    );
    return (await res.json()) as T;
  }

  private resolve(pathOrUrl: string, query?: Record<string, string>): string {
    const u = new URL(pathOrUrl, PCO_BASE);
    if (u.origin !== PCO_BASE) throw new Error("Refusing to send Planning Center credentials to another host");
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
    return u.toString();
  }
}

/** Converts transport errors to PcoError; errors from our own token provider pass through unchanged. */
function asPcoError(err: unknown): unknown {
  return err instanceof ProviderHttpError || err instanceof ProviderNetworkError ? toPcoError(err) : err;
}
