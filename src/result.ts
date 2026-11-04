/** A field-level problem, addressed by dotted path ("council.enabled", "claims.0.red.exitCode"). */
export interface FieldError {
  path: string;
  message: string;
}

export function toFieldErrors(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): FieldError[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}
