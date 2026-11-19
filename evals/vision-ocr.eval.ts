import { it } from "vitest";
import { VISION_OCR_SYSTEM_PROMPT } from "@/lib/ocr-vision";
import { createVisionEvaluationSuite } from "./vision-harness";
import { visionFixtures } from "./vision-fixtures";

const evaluate = createVisionEvaluationSuite(visionFixtures.length);
for (const sample of visionFixtures) {
  it(sample.id, () => evaluate({ ...sample, system: VISION_OCR_SYSTEM_PROMPT }));
}
