export const resolveEvalExecutionMetadata = (
  parsedMetadata: unknown,
): string | null => {
  if (typeof parsedMetadata !== "object" || parsedMetadata === null)
    return null;

  const targetTraceId = (parsedMetadata as Record<string, unknown>)
    .target_trace_id;

  return typeof targetTraceId === "string" && targetTraceId.length > 0
    ? targetTraceId
    : null;
};
