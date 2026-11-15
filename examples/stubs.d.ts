// Ambient stubs so the examples type-check without installing next-auth / pino / your app code.
declare module "@/lib/auth" {
  export function auth(): Promise<{ access_token?: string; accessToken?: string } | null>;
}
declare module "pino" {
  interface Pino {
    debug(meta: object, msg: string): void;
    info(meta: object, msg: string): void;
    warn(meta: object, msg: string): void;
    error(meta: object, msg: string): void;
    child(meta: object): Pino;
  }
  export default function pino(): Pino;
}
