import assert from "node:assert/strict";
import test from "node:test";

import { CAFES } from "../src/data.js";
import { HUANGPU_LAND_FRAME, projectCafeToHuangpu } from "../src/mapProjection.js";

test("projects every Huangpu cafe into the verified west-bank land frame", () => {
  for (const cafe of CAFES) {
    const [vertical, horizontal] = projectCafeToHuangpu(cafe);

    assert.ok(vertical >= HUANGPU_LAND_FRAME.bottom && vertical <= HUANGPU_LAND_FRAME.top);
    assert.ok(horizontal >= HUANGPU_LAND_FRAME.left && horizontal <= HUANGPU_LAND_FRAME.right);
  }
});

test("keeps numeric cafe markers from overlapping", () => {
  const positions = CAFES.map((cafe) => ({ id: cafe.id, position: projectCafeToHuangpu(cafe) }));

  for (let index = 0; index < positions.length; index += 1) {
    for (let comparison = index + 1; comparison < positions.length; comparison += 1) {
      const [firstVertical, firstHorizontal] = positions[index].position;
      const [secondVertical, secondHorizontal] = positions[comparison].position;
      const distance = Math.hypot(
        firstVertical - secondVertical,
        firstHorizontal - secondHorizontal,
      );

      assert.ok(
        distance >= 52,
        `${positions[index].id} and ${positions[comparison].id} are only ${distance.toFixed(1)}px apart`,
      );
    }
  }
});
