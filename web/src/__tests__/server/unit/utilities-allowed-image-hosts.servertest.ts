// The allowlist is parsed once at module scope, so it has to be set before the
// router module is imported. `vi.hoisted` runs before every import is evaluated.
vi.hoisted(() => {
  process.env.LANGFUSE_ALLOWED_IMAGE_HOSTS = "minio.internal, cdn.internal";
});

import { isValidAndSecureUrl } from "@/src/server/api/routers/utilities";

describe("LANGFUSE_ALLOWED_IMAGE_HOSTS", () => {
  it("accepts an allowlisted host even on plain http", async () => {
    await expect(
      isValidAndSecureUrl("http://minio.internal/media/image.png"),
    ).resolves.toBe(true);
  });

  it("ignores surrounding whitespace in the allowlist", async () => {
    await expect(
      isValidAndSecureUrl("http://cdn.internal/image.png"),
    ).resolves.toBe(true);
  });

  it("keeps validating hosts that are not allowlisted", async () => {
    await expect(
      isValidAndSecureUrl("http://other.internal/image.png"),
    ).resolves.toBe(false);
  });
});
