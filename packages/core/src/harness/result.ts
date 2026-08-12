/** Result + tagged errors, ported from pi-agent-core harness/result.ts. */

export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

export const Result = {
  ok<TValue>(value: TValue): { ok: true; value: TValue } {
    return { ok: true, value };
  },
  err<TError>(error: TError): { ok: false; error: TError } {
    return { ok: false, error };
  },
};

export interface TaggedErrorValue<Tag extends string> extends Error {
  readonly _tag: Tag;
}

export interface TaggedErrorFactory<Tag extends string> {
  new <Props extends { message: string }>(props: Props): TaggedErrorValue<Tag> & Readonly<Props>;
  is(value: unknown): value is TaggedErrorValue<Tag>;
}

export function TaggedError<Tag extends string>(tag: Tag): TaggedErrorFactory<Tag> {
  class Tagged extends Error {
    readonly _tag = tag;
    constructor(props: { message: string }) {
      super(props.message);
      Object.assign(this, props);
    }
    static is(value: unknown): boolean {
      return value instanceof Error && (value as { _tag?: string })._tag === tag;
    }
  }
  return Tagged as unknown as TaggedErrorFactory<Tag>;
}
