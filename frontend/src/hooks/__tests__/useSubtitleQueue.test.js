import { describe, it, expect } from "vitest";
import { splitSentences } from "../useSubtitleQueue";

describe("splitSentences", () => {
  it("returns [] for empty / null input", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences(null)).toEqual([]);
    expect(splitSentences(undefined)).toEqual([]);
  });

  it("splits on sentence boundaries and preserves punctuation", () => {
    const out = splitSentences("Hello world. How are you? I am fine!");
    expect(out).toEqual(["Hello world.", "How are you?", "I am fine!"]);
  });

  it("strips markdown bold and code fences", () => {
    const out = splitSentences("**Bold** text. ```code block here``` Real text.");
    expect(out.join(" ")).not.toMatch(/\*\*/);
    expect(out.join(" ")).not.toMatch(/```/);
    expect(out.some((s) => s.includes("Real text"))).toBe(true);
  });

  it("collapses whitespace and trims", () => {
    expect(splitSentences("  Hi   there.   Bye.  ")).toEqual(["Hi there.", "Bye."]);
  });

  it("handles a single sentence without trailing punctuation", () => {
    expect(splitSentences("Just one fragment")).toEqual(["Just one fragment"]);
  });

  it("drops empty fragments produced by stripped markdown", () => {
    const out = splitSentences("```only-code```");
    expect(out).toEqual([]);
  });

  it("strips unordered list markers", () => {
    const out = splitSentences("- Visit Paris. - Try the wine.");
    expect(out).toEqual(["Visit Paris.", "Try the wine."]);
  });

  it("strips numbered list markers", () => {
    const out = splitSentences("1. Book flights. 2. Reserve hotels.");
    expect(out).toEqual(["Book flights.", "Reserve hotels."]);
  });

  it("converts em-dashes to commas", () => {
    const out = splitSentences("Paris — city of lights — awaits.");
    expect(out).toEqual(["Paris, city of lights, awaits."]);
  });

  it("strips markdown headings", () => {
    const out = splitSentences("## Day 1\nFly to Tokyo.");
    expect(out).toEqual(["Fly to Tokyo."]);
  });

  it("strips bullet points with • character", () => {
    const out = splitSentences("• Eiffel Tower. • Louvre Museum.");
    expect(out).toEqual(["Eiffel Tower.", "Louvre Museum."]);
  });
});
