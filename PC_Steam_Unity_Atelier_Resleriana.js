// ==UserScript==
// @name         Atelier Resleriana: The Red Alchemist & the White Guardian (紅の錬金術士と白の守護者 ～レスレリアーナのアトリエ～)
// @version      0.1
// @author       Mansive
// @description  Steam
// * Gust
// * KOEI TECMO GAMES CO., LTD.
// * Unity (IL2CPP)
// https://store.steampowered.com/app/2698470/Kemono_Teatime/
// ==/UserScript==

//#region Types

/**
 * @callback TreasureArgsFunction
 * @param {Object} treasure
 * @param {InvocationArguments} treasure.args
 * @returns {NativePointer}
 */

/**
 * @callback TreasureContextFunction
 * @param {Object} treasure
 * @param {X64CpuContext} treasure.context
 * @returns {NativePointer}
 */

/**
 * @typedef {Object} TargetHook
 * @property {string} name
 * @property {string | MatchPattern} pattern
 * @property {NativePointer} address
 * @property {string} register
 * @property {number} argIndex
 * @property {TreasureArgsFunction | TreasureContextFunction} getTreasureAddress
 */

/**
 * @typedef {Object} Hook
 * @property {string | MatchPattern} pattern
 * @property {string=} register
 * @property {number=} argIndex
 * @property {TargetHook=} target
 * @property {string[]=} origins
 * @property {HookHandler} handler
 */

/**
 * New InvocationContext with specified X64CpuContext because VSCode can't
 * perfectly resolve the generic CpuContext
 * @typedef {Omit<InvocationContext, "context"> & { context: X64CpuContext }} X64InvocationContext
 */

/**
 * @callback HookHandler
 * @this {X64InvocationContext}
 * @param {NativePointer} address
 * @returns {string | null=}
 */

//#endregion

//#region Some Globals

const ui = require("./libUI.js");
const Mono = require("./libMono.js");
const __e = Process.findModuleByName("GameAssembly.dll");

const BACKTRACE = false;

let INSPECT_ARGS_REGS = false;
let DEBUG_LOGS = true;

let convertToSingleLine = true;

let hooksPrimaryCount = 0;
let hooksAuxCount = 0;

let timer1 = null;
let timer2 = null;
let timer3 = null;

let previous = "";

/** @type {string[]} */
// event/MM01/EVENT_MESSAGE_MM01_010.ebm
const eventTexts = [];
let previousEventId = 0;
const encoder = new TextEncoder();

const texts1 = new Set();
const texts2 = new Set();

const priorityTexts = new Set();
let topText = "";
let middleText = "";
const bottomTexts = new Set();
let deepText = "";

const returnAddresses = new Set();

//#endregion

//#region Hooks

const hooksStatus = {
  // exampleHookName: { enabled: true, characters: 0 },
};

/** @type {Object.<string, TargetHook>} */
const targetHooks = {
  // SHALLOW: {
  //   name: "SHALLOW",
  //   pattern: "48 89 5C 24 08 48 89 74 24 10 57 48 83 EC 20 33 F6 40 38 32",
  //   address: NULL,
  //   register: "rdx",
  //   argIndex: 1,
  //   /** @type {TreasureContextFunction} */
  //   getTreasureAddress({ context }) {
  //     return context[this.register];
  //   },
  // },
};

//#region Hooks: Main

const hooksMain = {
  // DialogueName: {
  //   pattern: "E8 37E22A00",
  //   target: targetHooks.SHALLOW,
  //   handler: dialogueTextHandler,
  // },
  // DialogueText: {
  //   pattern: "E8 5A762300",
  //   register: "r8",
  //   handler: dialogueTextHandler,
  // },
};

//#endregion

//#region Hooks: Misc

const hooksMiscellaneous = {
  InterfaceText: {
    //E8 79 9F AD 01 48 8B 6C 24 48 48 8B 5C 24 40 48 8B 74 24 50 48 83 C4 30 5F C3
    pattern: "E8 79 9F AD 01",
    register: "rbx",
    handler: mainHandler,
  },
  // InterfaceText2: {
  //   // RenewalDelegate..ctor
  // }
};

//#endregion

//#region Hooks: Battle

const hooksBattle = {};

//#endregion

//#region Hooks: Synth

const hooksSynthesis = {};

//#endregion

//#region Hooks: Ency

const hooksEncyclopedia = {};

//#endregion

//#region Hooks: All

// Combine all sets of hooks into one object for ease of use
/** @type {Object.<string, Hook>} */
const hooks = Object.assign(
  {},
  hooksMain,
  hooksMiscellaneous,
  hooksBattle,
  hooksSynthesis,
  hooksEncyclopedia
);

const hooksPrimaryTotal = Object.keys(hooks).length;

//#endregion

//#endregion

//#region Strategies

function monoOnEnterStrategy({ monoThing, handler }) {
  const { className, methodName, argCount } = monoThing;
  Mono.setHook("", className, methodName, argCount, handler);
}

/**
 * Returns a NativePointer from either the arguments or registers depending
 * on how the targeted hook extracts text.
 * @param {Object} options
 * @param {TargetHook} options.target
 * @param {InvocationArguments} options.args
 * @param {X64CpuContext} options.context
 * @returns {NativePointer}
 */
function getTreasureAddress({ target, args, context }) {
  return target.getTreasureAddress({ args, context });
}

/**
 * Hooks an address and checks the return addresses before invoking the handler.
 * @param {Hook & {name: string} & {address: NativePointer}}
 */
function filterReturnsStrategy({ address, name, register, handler }) {
  Breakpoint.add(address, {
    onEnter() {
      const returnAddress = this.context.rsp.readPointer();
      // console.warn("filtering: " + returnAddress);

      if (returnAddresses.has(returnAddress.toInt32())) {
        DEBUG_LOGS && console.warn("passedFilter: " + name);

        if (hooksStatus[name].enabled === false) {
          logDim("skipped: " + name);
          return false;
        }

        if (INSPECT_ARGS_REGS === true) {
          console.log("in: ORIGIN");
          inspectRegs(this.context);
        }

        const text = handler.call(this, this.context[register]);
        setHookCharacterCount(name, text);
      } else {
        // console.warn(`Current return address: ${this.returnAddress}
        // \rreturnAddresses Set: ${JSON.stringify(returnAddresses)}`);
      }
    },
  });
}

/**
 * Hooks an address as the origin, then temporarily hooks a target address
 * whenever the origin is accessed.
 * @param {Hook & {name: string} & {address: NativePointer}}
 */
function nestedHooksStrategy({ address, name, target, handler }) {
  Breakpoint.add(address, {
    onEnter() {
      if (hooksStatus[name].enabled === false) {
        logDim("skipped: " + name);
        return false;
      }

      console.log("onEnter: " + name);

      if (INSPECT_ARGS_REGS === true) {
        console.log("in: ORIGIN");
        inspectRegs(this.context);
      }

      // this.outerArgs = outerArgs;

      hotAttach(target.address, function () {
        if (INSPECT_ARGS_REGS === true) {
          console.log("in: TARGET");
          inspectRegs(this.context);
        }

        const text = handler(getTreasureAddress({ target, context: this.context }));

        setHookCharacterCount(name, text);
      });
    },
  });
}

/**
 * Combination of {@link nestedHooksStrategy} and {@link filterReturnsStrategy}.
 * @param {Hook & {name: string} & {address: NativePointer}}
 */
function filterReturnsNestedHooksStrategy({ address, name, target, handler }) {
  Breakpoint.add(address, {
    onEnter() {
      const returnAddress = this.context.rsp.readPointer();
      // console.warn("filtering: " + returnAddress);

      if (returnAddresses.has(returnAddress.toInt32())) {
        DEBUG_LOGS && console.warn("passedFilter: " + name);

        if (hooksStatus[name].enabled === false) {
          logDim("skipped: " + name);
          return false;
        }

        console.log("onEnter: " + name);

        if (INSPECT_ARGS_REGS === true) {
          console.log("in: ORIGIN");
          inspectRegs(this.context);
        }

        // const outerContext = this.context;

        hotAttach(target.address, function () {
          if (INSPECT_ARGS_REGS === true) {
            console.log("in: TARGET");
            inspectRegs(this.context);
          }

          // this.outerContext = outerContext;

          const text = handler(getTreasureAddress({ target, context: this.context }));

          setHookCharacterCount(name, text);
        });
      } else {
        // ...
      }
    },
  });
}

/** @param {Hook & {name: string} & {address: NativePointer}} */
function normalStrategy({ address, name, register, handler }) {
  Interceptor.attach(address, function (args) {
    if (hooksStatus[name].enabled === false) {
      logDim("skipped: " + name);
      return false;
    }

    console.log("onEnter: " + name);

    if (INSPECT_ARGS_REGS === true) {
      inspectRegs(this.context);
      inspectArgs(args);
    }

    const text = handler.call(this, this.context[register]) ?? null;

    setHookCharacterCount(name, text);
  });
}

//#endregion

//#region Attach

/**
 * Wrapper around "Interceptor.attach". Quickly detach after attaching.
 * @param {NativePointer} address
 * @param {Function} callback
 */
function hotAttach(address, callback) {
  const hook = Interceptor.attach(address, function (args) {
    hook.detach();
    Interceptor.flush();

    this.args = args;

    callback.call(this, args);
  });
}

/**
 * Scans a pattern in memory and returns a NativePointer for first match.
 * @param {string} name
 * @param {string} pattern
 * @returns {NativePointer}
 */
function getPatternAddress(name, pattern) {
  let results = "";

  try {
    results = Memory.scanSync(__e.base, __e.size, pattern);
  } catch (err) {
    throw new Error(`Error ocurred with [${name}]: ${err.message}`, {
      cause: err,
    });
  }

  if (results.length === 0) {
    throw new Error(`[${name}] Not found!`);
  }

  const address = results[0].address;

  console.log(`\x1b[32m[${name}] @ ${address}\x1b[0m`);
  if (results.length > 1) {
    console.warn(`${name} has ${results.length} results`);
    // console.log(results[0].address, results[1].address);
  }

  return address;
}

function setupHooks() {
  for (const hook in targetHooks) {
    const name = hook;
    const pattern = targetHooks[name].pattern;
    targetHooks[hook].address = getPatternAddress(name, pattern);
    hooksAuxCount += 1;
  }

  for (const hook in hooks) {
    const name = hook;
    const origins = hooks[hook].origins;

    if (origins) {
      for (const origin of origins) {
        returnAddresses.add(getPatternAddress(name + "RETURN", origin).toUInt32());
        hooksAuxCount += 1;
      }
    }

    const result = attachHook({ name, ...hooks[hook] });

    if (result === true) {
      hooksStatus[name] = { enabled: true, characters: 0 };
      hooksPrimaryCount += 1;
    } else {
      console.log("FAIL");
    }
  }

  console.log(`
${hooksPrimaryCount} primary hooks attached
${hooksAuxCount} auxiliary hooks on standby
${hooksPrimaryCount + hooksAuxCount} total hooks
  `);
}

/**
 * In order from least to greatest priority:\
 * If {@link target} is provided, the hook will use it.\
 * If {@link origins} is provided, return addresses will filter the hook.
 * @param {Hook & {name: string}} params
 * @returns {boolean}
 */
function attachHook(params) {
  const { name, pattern, target, origins, monoThing } = params;

  if (monoThing) {
    monoOnEnterStrategy(params);
  }

  const address = getPatternAddress(name, pattern);
  const args = { address, ...params };

  if (origins && target) {
    DEBUG_LOGS &&
      console.log(`[${name}] filtered with return addresses and targeting [${target.name}]`);
    filterReturnsNestedHooksStrategy(args);
  } else if (origins) {
    DEBUG_LOGS && console.log(`[${name}] filtered with return addresses`);
    filterReturnsStrategy(args);
  } else if (target) {
    DEBUG_LOGS && console.log(`[${name}] targeting [${target.name}]`);
    nestedHooksStrategy(args);
  } else {
    normalStrategy(args);
  }

  return true;
}

//#endregion

//#region Handlers

function readString(address) {
  const text = address.add(0x14).readUtf16String();

  DEBUG_LOGS && console.log(`${color.FgYellow}${JSON.stringify(text)}${color.Reset}`);

  return text;
}

/** @param {string} text */
function genericHandler(text) {
  texts1.add(text);

  clearTimeout(timer1);
  timer1 = setTimeout(() => {
    trans.send([...texts1].join("\r\n"));
    texts1.clear();
  }, 200);
}

/** @type {HookHandler} */
function mainHandler(address) {
  const text = readString(address);

  genericHandler(text);
  return text;
}

trans.replace((s) => {
  // if (s === previous || s === "") {
  //   return null;
  // }
  // previous = s;

  return s;
});

//#endregion

//#region Miscellaneous

/**
 * Attempts to print arguments' values as strings.
 * @param {InvocationArguments} args
 */
function inspectArgs(args) {
  const argsTexts = [];

  for (let i = 0; i <= 10; i++) {
    let type = "";
    let text = "";

    // yeehaw
    try {
      type = "S";
      text = args[i].add(0x14).readUtf16String();
    } catch (err) {
      try {
        type = "P";
        text = args[i].readPointer().add(0x14).readUtf16String();
      } catch (err) {
        try {
          type = "PP";
          text = args[i].readPointer().readPointer().add(0x14).readUtf16String();
        } catch (err) {
          // type = "A";
          // text = args[i].toString();
          continue;
        }
      }
    }

    if (text === null || text.length === 0 || /^\\/g.test()) {
      continue;
    }

    // text += args[i].toString();
    argsTexts.push(`${type}|args[${i}]=${JSON.stringify(text)}`);
  }

  for (const text of argsTexts) {
    console.log(`${color.BgMagenta}${text}${color.Reset}`);
  }
  argsTexts.length = 0;
}

/**
 * Attempts to print registers' values as strings.
 * @param {X64CpuContext} context
 */
function inspectRegs(context) {
  const regsTexts = [];
  const regs = [
    "rax",
    "rbx",
    "rcx",
    "rdx",
    "rsi",
    "rdi",
    "rbp",
    "rsp",
    "r8",
    "r9",
    "r10",
    "r11",
    "r12",
    "r13",
    "r14",
    "r15",
    // "rip",
  ];

  let text = "";
  let address = NULL;

  for (const reg of regs) {
    address = context[reg];
    try {
      text = address.add(0x14).readUtf16String();
    } catch (err) {
      continue;
    }

    if (text === null || text.length === 0 || /^\\/g.test()) {
      continue;
    }

    regsTexts.push(`${reg}=${JSON.stringify(text)}`);
  }

  for (const text of regsTexts) {
    console.log(`${color.BgBlue}${text}${color.Reset}`);
  }
  regsTexts.length = 0;
}

/** Prints the backtrace or callstack for a hook. */
function startTrace() {
  console.warn("Tracing!!");

  const traceTarget = targetHooks.SHALLOW;

  const traceAddress = getPatternAddress(traceTarget.name, traceTarget.pattern);
  traceTarget.address = traceAddress;
  const previousTexts = new Set();

  Interceptor.attach(traceAddress, {
    onEnter(args) {
      let text = "";
      const context = this.context;
      try {
        text = getTreasureAddress({
          target: traceTarget,
          args,
          context,
        })
          .add(0x14)
          .readUtf16String();
      } catch (err) {
        console.error("Reading from address failed:", err.message);
        return null;
      }

      if (previousTexts.has(text)) {
        return null;
      }
      previousTexts.add(text);

      const callstack = Thread.backtrace(this.context, Backtracer.ACCURATE);

      console.log(`
        \rONENTER: ${traceTarget.name}
        \r${text}
        \rCallstack: ${callstack.splice(0, 8)}
        \rReturn: ${this.returnAddress}`);

      if (INSPECT_ARGS_REGS === true) {
        inspectArgs(args);
        inspectRegs(this.context);
      }
    },
  });
}

function setHookCharacterCount(name, text) {
  if (text === null || text === "") {
    return null;
  }

  const cleanedText = text.replace(/[。…、？！「」―ー・]|<[^>]+>|\r|\n|\u3000/gu, "");
  hooksStatus[name].characters += cleanedText.length;
}

// in case im being a dumbass
function validateHooks() {
  function expose(name, property) {
    throw new TypeError(`[${name}] ${property} is of type ${typeof property}`);
  }

  for (const hookName in hooks) {
    const hook = hooks[hookName];
    const { pattern, register, argIndex, target, origins, handler } = hook;

    if (typeof pattern !== "string") {
      expose(hookName, pattern);
    }
    if (typeof handler !== "function") {
      expose(hookName, handler);
    }
    if (register && argIndex) {
      expose(hookName, argIndex);
    }
    if (argIndex && !target && typeof argIndex !== "number") {
      expose(hookName, argIndex);
    }
    if (register && !target && typeof register !== "string") {
      expose(hookName, register);
    } else if (!register && target && typeof target !== "object") {
      expose(hookName, target);
    } else if (register && target && origins) {
      expose(hookName, origins);
    }
  }
}

// https://stackoverflow.com/a/57100519
const color = {
  Reset: "\x1b[0m",
  Bright: "\x1b[1m",
  Dim: "\x1b[2m",
  Underscore: "\x1b[4m",
  Blink: "\x1b[5m",
  Reverse: "\x1b[7m",
  Hidden: "\x1b[8m",

  FgBlack: "\x1b[30m",
  FgRed: "\x1b[31m",
  FgGreen: "\x1b[32m",
  FgYellow: "\x1b[33m",
  FgBlue: "\x1b[34m",
  FgMagenta: "\x1b[35m",
  FgCyan: "\x1b[36m",
  FgWhite: "\x1b[37m",
  FgGray: "\x1b[90m",

  BgBlack: "\x1b[40m",
  BgRed: "\x1b[41m",
  BgGreen: "\x1b[42m",
  BgYellow: "\x1b[43m",
  BgBlue: "\x1b[44m",
  BgMagenta: "\x1b[45m",
  BgCyan: "\x1b[46m",
  BgWhite: "\x1b[47m",
  BgGray: "\x1b[100m",
};

function logDim(message) {
  console.log(`${color.Dim}${message}${color.Reset}`);
}

//#endregion

//#region UI Config

// Now that I removed the ability to enable/disable individual hooks, I can clean
// up the script by passing in arrays into the UI options instead of hardcoded
// values like in the Atelier Sophie script
function getHookOptions(subset) {
  const options = [];
  for (const hookName in subset) {
    options.push({ value: hookName, text: hookName });
  }

  return options;
}

// Hacky way to avoid libUI bug?
function getEnabledCount() {
  let enabledCount = 0;
  for (const thing in hooksStatus) {
    if (hooksStatus[thing].enabled === true) {
      enabledCount++;
    }
  }

  return enabledCount;
}

// getHookOptions();

ui.title = "Atelier Firis";
ui.description = /*html*/ `
<small class='text-muted'>Game Version: <code>1.02</code></small>
<br>Configure text output and which hooks are enabled.
<br>Check Agent's console output to see each text's corresponding hook.
`;

// ui.storage = false;

//prettier-ignore
ui.options = [
  {
    id: "singleSentence",
    type: "checkbox",
    label: "Single-line sentences",
    help: `Attempt to convert sentences that span multiple lines into a single line.
    Useful for external apps that need to parse sentences.
    Disable if you want to retain the text's original formatting.`,
    defaultValue: true,
  },
  {
    id: "enableHooksName",
    type: "checkbox",
    label: "Enable DialogueName Hook",
    help: `Enable the main dialogue's name hook.`,
    defaultValue: true
  },
  {
    id: "enableHooksMiscellaneous",
    type: "checkbox",
    label: "Enable Miscellaneous Hooks",
    defaultValue: true
  },
  {
    id: "enableHooksBattle",
    type: "checkbox",
    label: "Enable Battle Hooks",
    defaultValue: true
  },
  {
    id: "enableHooksSynthesis",
    type: "checkbox",
    label: "Enable Synthesis Hooks",
    defaultValue: true
  },
  {
    id: "enableHooksEncyclopedia",
    type: "checkbox",
    label: "Enable Encyclopedia Hooks",
    defaultValue: true
  },
  {
    id: "hooksEnabledCount",
    type: "text",
    label: "Number of hooks enabled",
    readOnly: true,
    defaultValue: "0",
    ephemeral: true,
  },
  {
    id: "selectedHook",
    type: "select",
    label: "Display character count from...",
    help: "Select a hook to display its character count.",
    options: getHookOptions(hooks).sort((a, b) => a.value.localeCompare(b.text)),
    defaultValue: "DialogueText",
  },
  {
    id: "selectedHookCharacterCount",
    type: "number",
    label: "Character count for selected hook",
    help: `Displays the total number of characters outputted by the selected hook.
    <br>Resets with each session.`,
    readOnly: true,
    defaultValue: 0,
    ephemeral: true,
  },
  {
    id: "hooksMain",
    type: "select",
    label: "Main Hooks",
    help: `Dialogue during cutscenes and choices.
    <br>Only the DialogueName hook can be enabled/disabled.`,
    multiple: true,
    options: getHookOptions(hooksMain),
    ephemeral: true,
  },
  {
    id: "hooksMiscellaneous",
    type: "select",
    label: "Miscellaneous Hooks",
    help: `Trivial text while exploring, quest objectives, menu text, etc.`,
    multiple: true,
    options: getHookOptions(hooksMiscellaneous),
    ephemeral: true,
  },
  {
    id: "hooksBattle",
    type: "select",
    label: "Battle Hooks",
    help: `Text or notifications appearing in battle.`,
    multiple: true,
    options: getHookOptions(hooksBattle),
    ephemeral: true,
  },
  {
    id: "hooksSynthesis",
    type: "select",
    label: "Synthesis Hooks",
    help: `Synthesis-relevant text such as recipe info and item traits.`,
    multiple: true,
    options: getHookOptions(hooksSynthesis),
    ephemeral: true,
  },
  {
    id: "hooksEncyclopedia",
    type: "select",
    label: "Encyclopedia Hooks",
    help: `Encyclopedia entries' texts.`,
    multiple: true,
    options: getHookOptions(hooksEncyclopedia),
    ephemeral: true,
  },
  {
    id: "debugLogs",
    type: "checkbox",
    label: "Show debugging information in console",
    defaultValue: false
  },
];

ui.onchange = (id, current, previous) => {
  if (id.startsWith("enableHooks") === true) {
    if (id === "enableHooksName") {
      hooksStatus["DialogueName"].enabled = current;
    } else {
      let subset = {};

      if (id === "enableHooksMiscellaneous") {
        subset = hooksMiscellaneous;
      } else if (id === "enableHooksBattle") {
        subset = hooksBattle;
      } else if (id === "enableHooksSynthesis") {
        subset = hooksSynthesis;
      } else if (id === "enableHooksEncyclopedia") {
        subset = hooksEncyclopedia;
      } else {
        console.error("Unknown id", id);
      }

      for (const hookName in subset) {
        hooksStatus[hookName].enabled = current;
      }
    }

    logDim(`UI: ${id} set to ${current}`);
    ui.config.hooksEnabledCount = `${getEnabledCount()} / ${hooksPrimaryTotal}`;
  } else if (id === "selectedHook") {
    logDim(`UI: Now displaying character count of [${current}]`);
    ui.config.selectedHookCharacterCount = hooksStatus[current].characters;
  } else if (id === "singleSentence") {
    current === true
      ? logDim("UI: Converting sentences to single-line")
      : logDim("UI: Maintaining sentences' original format");
    convertToSingleLine = current;
  } else if (id === "debugLogs") {
    current === true
      ? logDim("UI: Enabling debug information")
      : logDim("UI: Disabling debug information");
    INSPECT_ARGS_REGS = current;
    DEBUG_LOGS = current;
  }
};

function uiStart() {
  // Update character count every 5 seconds
  setInterval(() => {
    ui.config.selectedHookCharacterCount = hooksStatus[ui.config.selectedHook].characters;
  }, 5000);

  ui.open()
    .then(() => {
      ui.config.hooksEnabledCount = `${getEnabledCount()} / ${hooksPrimaryTotal}`;
      console.log("UI: UI loaded!");
    })
    .catch((err) => {
      console.error("UI error\n" + err.stack);
    });
}

//#endregion

//#region Start

function start() {
  if (BACKTRACE === true) {
    startTrace();
    return true;
  }

  validateHooks();
  setupHooks();
  // uiStart();
}

start();

//#endregion
