/** Types for src/pwa/swRules.js, which is served to the worker as plain JavaScript. */

export interface RequestLike { url: string; method?: string; mode?: string }
export interface ResponseLike { status: number; ok: boolean; type: string; headers: { get(name: string): string | null } }

export type Route = "network" | "shell" | "asset" | "static";

export declare const neverCached: RegExp[];
export declare function routeFor(request: RequestLike, origin: string): Route;
export declare function cacheable(response: ResponseLike | null | undefined): boolean;
export declare function isShell(response: ResponseLike | null | undefined): boolean;
export declare function safeOpenUrl(value: unknown, origin: string): string;
export declare function notificationFrom(payload: unknown, origin: string): { title: string; options: { body: string; tag: string; icon: string; badge: string; data: { url: string } } };
