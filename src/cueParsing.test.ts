import {
  parseBlackoutValue,
  parseColorloopValue,
  parseFlickerValue,
  parseGroupSwitchValue,
  parsePartyValue,
  parseShowSceneOnGroupValue,
  parseShowSceneValue,
} from "./cueParsing";

describe("parseShowSceneOnGroupValue", () => {
  it("group and scene", () => {
    expect(parseShowSceneOnGroupValue("83|Blackout")).toEqual({
      groupId: "83",
      sceneName: "Blackout",
      transitionTime: undefined,
    });
  });

  it("group, scene, and transition time", () => {
    expect(parseShowSceneOnGroupValue("84|Act 1|10")).toEqual({
      groupId: "84",
      sceneName: "Act 1",
      transitionTime: 10,
    });
  });

  it("missing scene name", () => {
    expect(parseShowSceneOnGroupValue("83")).toEqual({
      groupId: "83",
      sceneName: undefined,
      transitionTime: undefined,
    });
  });

  it("empty string", () => {
    expect(parseShowSceneOnGroupValue("")).toEqual({
      groupId: undefined,
      sceneName: undefined,
      transitionTime: undefined,
    });
  });

  it("non-numeric transition time is ignored", () => {
    expect(parseShowSceneOnGroupValue("83|Scene|fast")).toEqual({
      groupId: "83",
      sceneName: "Scene",
      transitionTime: undefined,
    });
  });
});

describe("parseBlackoutValue", () => {
  it("group only", () => {
    expect(parseBlackoutValue("83")).toEqual({ groupId: "83", transitionTime: undefined });
  });

  it("group with transition time", () => {
    expect(parseBlackoutValue("83|20")).toEqual({ groupId: "83", transitionTime: 20 });
  });

  it("transition 0 parses as 0 (engine applies the v0.2.1 default-fallback quirk)", () => {
    expect(parseBlackoutValue("83|0")).toEqual({ groupId: "83", transitionTime: 0 });
  });

  it("empty string", () => {
    expect(parseBlackoutValue("")).toEqual({ groupId: undefined, transitionTime: undefined });
  });
});

describe("parseGroupSwitchValue", () => {
  it("plain group id", () => {
    expect(parseGroupSwitchValue("85")).toEqual({ groupId: "85" });
  });

  it("ignores extra pipe segments", () => {
    expect(parseGroupSwitchValue("85|junk")).toEqual({ groupId: "85" });
  });

  it("empty string", () => {
    expect(parseGroupSwitchValue("")).toEqual({ groupId: undefined });
  });
});

describe("parseShowSceneValue", () => {
  it("plain scene name", () => {
    expect(parseShowSceneValue("Blackout")).toEqual({ sceneName: "Blackout" });
  });

  it("scene name with transition time", () => {
    expect(parseShowSceneValue("Blackout|10")).toEqual({
      sceneName: "Blackout",
      transitionTime: 10,
    });
  });

  it("transition time of 0 (snap)", () => {
    expect(parseShowSceneValue("Blackout|0")).toEqual({ sceneName: "Blackout", transitionTime: 0 });
  });

  it("scene name containing a pipe", () => {
    expect(parseShowSceneValue("Act 1|Opening|5")).toEqual({
      sceneName: "Act 1|Opening",
      transitionTime: 5,
    });
  });

  it("non-numeric suffix stays part of the scene name", () => {
    expect(parseShowSceneValue("Day|Night")).toEqual({ sceneName: "Day|Night" });
  });

  it("empty string", () => {
    expect(parseShowSceneValue("")).toEqual({ sceneName: "" });
  });
});

describe("parseFlickerValue", () => {
  it("group only", () => {
    expect(parseFlickerValue("1")).toEqual({ groupId: "1", sceneName: undefined });
  });

  it("group with scene", () => {
    expect(parseFlickerValue("1|Candlelight")).toEqual({
      groupId: "1",
      sceneName: "Candlelight",
    });
  });

  it("empty value has no group", () => {
    expect(parseFlickerValue("").groupId).toBeUndefined();
  });
});

describe("parseColorloopValue", () => {
  it("full form", () => {
    expect(parseColorloopValue("0|200|150")).toEqual({ groupId: "0", bri: 200, sat: 150 });
  });

  it("defaults to 254 when missing or garbage", () => {
    expect(parseColorloopValue("0")).toEqual({ groupId: "0", bri: 254, sat: 254 });
    expect(parseColorloopValue("0|abc|xyz")).toEqual({ groupId: "0", bri: 254, sat: 254 });
  });

  it("clamps out-of-range channels into Hue's 1-254", () => {
    expect(parseColorloopValue("0|999|0")).toEqual({ groupId: "0", bri: 254, sat: 1 });
  });

  it("empty value has no group", () => {
    expect(parseColorloopValue("").groupId).toBeUndefined();
  });
});

describe("parsePartyValue", () => {
  it("full form", () => {
    expect(parsePartyValue("0|300")).toEqual({ groupId: "0", speedMs: 300 });
  });

  it("defaults to 300ms", () => {
    expect(parsePartyValue("0")).toEqual({ groupId: "0", speedMs: 300 });
    expect(parsePartyValue("0|abc")).toEqual({ groupId: "0", speedMs: 300 });
  });

  it("floors speed at 100ms", () => {
    expect(parsePartyValue("0|20")).toEqual({ groupId: "0", speedMs: 100 });
  });

  it("empty value has no group", () => {
    expect(parsePartyValue("").groupId).toBeUndefined();
  });
});
