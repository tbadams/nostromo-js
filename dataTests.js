"use strict"

function testAll() {
  return [
    testSelector_true(),
    testSelector_false()
    // TODO test when json is an int
    // TODO action alidity, esp. dying
  ];
}

function testSelector_true() {
  let json = {
    "is": {
      "category":"actors",
      "breathe":true
    },
    "has":[
      "health"
    ]
  };
  let selector = new Selector(json);
  let data = [
    {
      "category":"actors",
      "breathe":true,
      "health":20
    },
    {
      "category":"actors",
      "breathe":true,
      "health":40
    }
  ];

  return testSelector(selector, data, "shouldSelectTrue", true);
}

function testSelector_false() {
  let json = {
    "is": {
      "category":"actors",
      "breathe":true
    },
    "has":[
      "health"
    ]
  };
  let selector = new Selector(json);
  let data = [
        { // No health
          "category":"actors",
          "breathe":true,
        },
        { // wrong string val
          "category":"room",
          "breathe":true,
          "health":20
        },
        { // wrong bool val
          "category":"actors",
          "breathe":false,
          "health":20
        },
        { // no string key
          "breathe":true,
          "health":20
        },
        { // no bool
          "category":"actors",
          "health":20
        }
      ];

  return testSelector(selector, data, "shouldSelectFalse", false);
}

function testSelector(selector, data, testName, shouldSelect) {
  let passed = true;
  let message = "";
  for (let datum of data) {
    if (selector.shouldSelect(datum) != shouldSelect) {
      passed = false;
      message = "Expected shouldSelect()=" + shouldSelect + " for obj "
          + JSON.stringify(datum) + "\n and selector "
          + JSON.stringify(selector);
          break;
    }
  }

  return new TestResult(testName, passed, new Error(message));
}

class TestResult {
  constructor(name, passed, error) {
    this.name = name;
    this.passed = passed;
    if (!passed) {
          this.error = error;
    }
  }
}
