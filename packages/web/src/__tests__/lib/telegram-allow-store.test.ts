import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockReadFileSync, mockWriteFileSync, mockRenameSync, mockExistsSync, mockMkdirSync } =
  vi.hoisted(() => ({
    mockReadFileSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockRenameSync: vi.fn(),
    mockExistsSync: vi.fn().mockReturnValue(true),
    mockMkdirSync: vi.fn(),
  }));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
      writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
      renameSync: (...args: unknown[]) => mockRenameSync(...args),
      existsSync: (...args: unknown[]) => mockExistsSync(...args),
      mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    },
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    renameSync: (...args: unknown[]) => mockRenameSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  };
});

import { addToAllowStore, removeFromAllowStore, clearAllowStore } from "@/lib/telegram-allow-store";

describe("telegram-allow-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  describe("addToAllowStore", () => {
    it("creates store with user when file does not exist", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      addToAllowStore("8754697762");

      expect(mockWriteFileSync).toHaveBeenCalledOnce();
      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(written).toEqual({ version: 1, allowFrom: ["8754697762"] });
      // Atomic: writes tmp then renames
      expect(mockRenameSync).toHaveBeenCalledOnce();
    });

    it("adds user to existing store", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1, allowFrom: ["111222333"] }));

      addToAllowStore("8754697762");

      expect(mockWriteFileSync).toHaveBeenCalledOnce();
      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(written.allowFrom).toEqual(["111222333", "8754697762"]);
    });

    it("does not duplicate existing user", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1, allowFrom: ["8754697762"] }));

      addToAllowStore("8754697762");

      // Should not write if no change
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("creates credentials directory if it does not exist", () => {
      mockExistsSync.mockReturnValue(false);
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      addToAllowStore("8754697762");

      expect(mockMkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    });
  });

  describe("removeFromAllowStore", () => {
    it("removes user from store", () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ version: 1, allowFrom: ["8754697762", "111222333"] })
      );

      removeFromAllowStore("8754697762");

      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(written.allowFrom).toEqual(["111222333"]);
    });

    it("does nothing if user not in store", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1, allowFrom: ["111222333"] }));

      removeFromAllowStore("8754697762");

      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("does nothing if store does not exist", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      removeFromAllowStore("8754697762");

      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });

  describe("clearAllowStore", () => {
    it("writes empty allowFrom array", () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ version: 1, allowFrom: ["8754697762", "111222333"] })
      );

      clearAllowStore();

      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(written).toEqual({ version: 1, allowFrom: [] });
    });

    it("does nothing if store does not exist", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      clearAllowStore();

      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });
});
