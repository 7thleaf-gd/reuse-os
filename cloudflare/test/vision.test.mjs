import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeVisionAnnotation,
  suggestVisionQuery
} from "../src/vision.js";

test("Vision normalization keeps best guesses, entities, OCR and logos", () => {
  const result = normalizeVisionAnnotation({
    webDetection: {
      bestGuessLabels: [{ label: "Pampas Field Ass Kickers Light" }],
      webEntities: [
        { description: "Pampas Field Ass Kickers", score: 0.92 },
        { description: "Light!", score: 0.88 }
      ],
      pagesWithMatchingImages: [
        { url: "https://example.test/page", pageTitle: "Example" }
      ]
    },
    fullTextAnnotation: {
      text: "PAMPAS FIELD ASS KICKERS\nLIGHT!\nSLR-001"
    },
    logoAnnotations: [{ description: "Seventh Leaf Records", score: 0.7 }]
  });

  assert.deepEqual(result.best_guess_labels, ["Pampas Field Ass Kickers Light"]);
  assert.equal(result.web_entities[0].description, "Pampas Field Ass Kickers");
  assert.equal(result.ocr_lines[2], "SLR-001");
  assert.equal(result.logos[0].description, "Seventh Leaf Records");
  assert.equal(result.matching_pages[0].url, "https://example.test/page");
});

test("Vision query suggestion prefers best guess, then entities, then OCR", () => {
  assert.equal(
    suggestVisionQuery({
      best_guess_labels: ["Artist Album"],
      web_entities: [{ description: "Ignored", score: 1 }],
      ocr_lines: ["Ignored OCR"]
    }),
    "Artist Album"
  );

  assert.equal(
    suggestVisionQuery({
      best_guess_labels: [],
      web_entities: [
        { description: "Artist", score: 0.9 },
        { description: "Album", score: 0.8 }
      ],
      ocr_lines: []
    }),
    "Artist Album"
  );

  assert.equal(
    suggestVisionQuery({
      best_guess_labels: [],
      web_entities: [],
      ocr_lines: ["ARTIST", "ALBUM", "CAT-001"]
    }),
    "ARTIST ALBUM CAT-001"
  );
});
