import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithProgress } from "./fetchWithProgress";

function mockStreamedResponse(chunks: Uint8Array[], totalBytes: number) {
  let index = 0;
  const body = {
    getReader() {
      return {
        read: async () => {
          if (index < chunks.length) {
            const value = chunks[index++];
            return { done: false, value };
          }
          return { done: true, value: undefined };
        },
      };
    },
  };

  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-length": String(totalBytes) }),
    body,
  } as unknown as Response;
}

describe("fetchWithProgress", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("downloads all chunks and concatenates them in order", async () => {
    const chunkA = new Uint8Array([1, 2, 3]);
    const chunkB = new Uint8Array([4, 5]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockStreamedResponse([chunkA, chunkB], 5)),
    );

    const result = await fetchWithProgress("/circuits/vote_final.zkey");

    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reports progress after each chunk with byte counts", async () => {
    const chunkA = new Uint8Array([1, 2, 3]);
    const chunkB = new Uint8Array([4, 5]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockStreamedResponse([chunkA, chunkB], 5)),
    );

    const updates: Array<{ loadedBytes: number; totalBytes: number }> = [];
    await fetchWithProgress("/circuits/vote_final.zkey", (progress) => {
      updates.push(progress);
    });

    expect(updates).toEqual([
      { loadedBytes: 3, totalBytes: 5 },
      { loadedBytes: 5, totalBytes: 5 },
    ]);
  });

  it("throws when the response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      } as Response),
    );

    await expect(fetchWithProgress("/circuits/missing.zkey")).rejects.toThrow(
      /404/,
    );
  });
});
