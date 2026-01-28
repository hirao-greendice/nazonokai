import "./style.css";
import Phaser from "phaser";
import { initializeApp } from "firebase/app";
import {
  getDatabase,
  ref,
  set,
  update,
  onDisconnect,
  serverTimestamp,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  get,
  push,
} from "firebase/database";

type InputState = {
  left: boolean;
  right: boolean;
  jump: boolean;
};

type PlayerData = {
  name: string;
  input: InputState;
};

type PlayerActor = {
  id: string;
  data: PlayerData;
  text: Phaser.GameObjects.Text;
  body: Phaser.Physics.Arcade.Body;
  lastJumpAt: number;
};

const ROOM_ID = "default";
const MAX_PLAYERS = 16;

const firebaseConfig = {
  apiKey: "AIzaSyBoymoHFRaoxBgckn66yy_vpZs2sNJKajw",
  authDomain: "nazonokai-90d08.firebaseapp.com",
  databaseURL:
    "https://nazonokai-90d08-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "nazonokai-90d08",
  storageBucket: "nazonokai-90d08.firebasestorage.app",
  messagingSenderId: "261961466452",
  appId: "1:261961466452:web:d36f7c263260d334d6a3c1",
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const appElement = document.querySelector<HTMLDivElement>("#app");
if (!appElement) {
  throw new Error("Missing #app element");
}

appElement.innerHTML = `
  <div class="shell">
    <header class="topbar">
      <div class="brand">NAZONOKAI</div>
      <div id="presence" class="presence hidden">参加中</div>
      <div class="mode-actions">
        <button class="ghost" data-mode="screen">スクリーン</button>
        <button class="ghost" data-mode="controller">コントローラ</button>
      </div>
    </header>
    <main class="main">
      <section id="mode-select" class="panel">
        <h1>モードを選択</h1>
        <p>1台をスクリーンにして、他の端末をコントローラとして参加します。</p>
        <div class="mode-grid">
          <button class="mode-card" data-mode="screen">
            <span class="mode-title">スクリーン</span>
            <span class="mode-desc">全員の名前が同じステージで動く画面</span>
          </button>
          <button class="mode-card" data-mode="controller">
            <span class="mode-title">コントローラ</span>
            <span class="mode-desc">名前設定 + 左右移動 + ジャンプ</span>
          </button>
        </div>
        <div class="hint">
          URLに <span class="mono">?mode=screen</span> / <span class="mono">?mode=controller</span>
          でも直行できます。
        </div>
      </section>

      <section id="screen-root" class="panel hidden">
        <div class="screen-wrap">
          <div id="screen-canvas" class="screen-canvas"></div>
          <div class="screen-hint">16人まで参加可能。床と重力のみのシンプルステージ。</div>
        </div>
      </section>

      <section id="controller-root" class="panel hidden">
        <div class="controller">
          <label for="name-input">名前設定（最大10文字）</label>
          <input id="name-input" type="text" maxlength="10" placeholder="NAME" />
          <div class="controls">
            <div class="move">
              <button id="btn-left" class="control-btn">←</button>
              <button id="btn-right" class="control-btn">→</button>
            </div>
            <button id="btn-jump" class="jump-btn">JUMP</button>
          </div>
        </div>
      </section>
    </main>
    <footer id="status" class="status"></footer>
  </div>
`;

const statusElement = document.querySelector<HTMLDivElement>("#status");
const presenceElement = document.querySelector<HTMLDivElement>("#presence");
const modeSelect = document.querySelector<HTMLElement>("#mode-select");
const screenRoot = document.querySelector<HTMLElement>("#screen-root");
const controllerRoot = document.querySelector<HTMLElement>("#controller-root");
const modeButtons = document.querySelectorAll<HTMLButtonElement>("[data-mode]");

if (!statusElement || !presenceElement || !modeSelect || !screenRoot || !controllerRoot) {
  throw new Error("Missing layout elements");
}

const setStatus = (message: string, tone: "info" | "error" = "info") => {
  statusElement.textContent = message;
  statusElement.dataset.tone = tone;
};

const setPresence = (message: string | null) => {
  if (!message) {
    presenceElement.textContent = "";
    presenceElement.classList.add("hidden");
    return;
  }
  presenceElement.textContent = message;
  presenceElement.classList.remove("hidden");
};

const ensureFirebaseReady = () => true;

let cleanup: (() => void) | null = null;
let game: Phaser.Game | null = null;

const setMode = (mode: "screen" | "controller" | "select") => {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  setPresence(null);
  if (game) {
    game.destroy(true);
    game = null;
  }

  modeSelect.classList.toggle("hidden", mode !== "select");
  screenRoot.classList.toggle("hidden", mode !== "screen");
  controllerRoot.classList.toggle("hidden", mode !== "controller");

  if (mode === "screen") {
    if (ensureFirebaseReady()) {
      cleanup = initScreen();
      setStatus("スクリーン起動中。参加待ち…");
    }
  } else if (mode === "controller") {
    if (ensureFirebaseReady()) {
      cleanup = initController();
      setStatus("コントローラ起動中。参加待ち…");
    }
  } else {
    setStatus("モードを選択してください。");
  }

  const url = new URL(window.location.href);
  if (mode === "select") {
    url.searchParams.delete("mode");
  } else {
    url.searchParams.set("mode", mode);
  }
  window.history.replaceState({}, "", url);
};

modeButtons.forEach((button) => {
  const mode = button.dataset.mode as "screen" | "controller" | undefined;
  if (!mode) return;
  button.addEventListener("click", () => setMode(mode));
});

const initialMode = (() => {
  const param = new URLSearchParams(window.location.search).get("mode");
  if (param === "screen" || param === "controller") {
    return param;
  }
  return "select";
})();

setMode(initialMode);

const sanitizeName = (value: string) => {
  const trimmed = value.trim().slice(0, 10);
  return trimmed.length > 0 ? trimmed : "PLAYER";
};

const initController = () => {
  const nameInput = document.querySelector<HTMLInputElement>("#name-input");
  const leftButton = document.querySelector<HTMLButtonElement>("#btn-left");
  const rightButton = document.querySelector<HTMLButtonElement>("#btn-right");
  const jumpButton = document.querySelector<HTMLButtonElement>("#btn-jump");

  if (!nameInput || !leftButton || !rightButton || !jumpButton) {
    setStatus("コントローラUIの初期化に失敗しました。", "error");
    return () => undefined;
  }

  const inputState: InputState = { left: false, right: false, jump: false };
  let playerRef: ReturnType<typeof ref> | null = null;
  let active = true;
  let jumpTimer: number | null = null;

  const roomPlayersRef = ref(db, `rooms/${ROOM_ID}/players`);

  const cleanup = () => {
    active = false;
    if (jumpTimer !== null) {
      window.clearTimeout(jumpTimer);
      jumpTimer = null;
    }
    if (playerRef) {
      const refToRemove = playerRef;
      update(refToRemove, { input: { left: false, right: false, jump: false } }).catch(
        () => undefined,
      );
      setTimeout(() => removePlayer(refToRemove), 0);
    }
    detachEvents();
  };

  const removePlayer = (targetRef: ReturnType<typeof ref>) => {
    set(targetRef, null).catch(() => undefined);
  };

  const syncInput = () => {
    if (!active || !playerRef) return;
    update(playerRef, { input: { ...inputState } }).catch(() => undefined);
  };

  const pulseJump = () => {
    if (inputState.jump) return;
    inputState.jump = true;
    syncInput();
    if (jumpTimer !== null) {
      window.clearTimeout(jumpTimer);
    }
    jumpTimer = window.setTimeout(() => {
      inputState.jump = false;
      syncInput();
    }, 160);
  };

  const holdHandlers: Array<() => void> = [];

  const bindHold = (button: HTMLButtonElement, key: "left" | "right") => {
    const onDown = (event: PointerEvent) => {
      event.preventDefault();
      if (!inputState[key]) {
        inputState[key] = true;
        syncInput();
      }
      button.setPointerCapture(event.pointerId);
    };
    const onUp = (event: PointerEvent) => {
      event.preventDefault();
      if (inputState[key]) {
        inputState[key] = false;
        syncInput();
      }
      if (button.hasPointerCapture(event.pointerId)) {
        button.releasePointerCapture(event.pointerId);
      }
    };
    button.addEventListener("pointerdown", onDown);
    button.addEventListener("pointerup", onUp);
    button.addEventListener("pointerleave", onUp);
    button.addEventListener("pointercancel", onUp);
    holdHandlers.push(() => {
      button.removeEventListener("pointerdown", onDown);
      button.removeEventListener("pointerup", onUp);
      button.removeEventListener("pointerleave", onUp);
      button.removeEventListener("pointercancel", onUp);
    });
  };

  bindHold(leftButton, "left");
  bindHold(rightButton, "right");

  const onJump = (event: PointerEvent) => {
    event.preventDefault();
    pulseJump();
  };
  jumpButton.addEventListener("pointerdown", onJump);
  holdHandlers.push(() => jumpButton.removeEventListener("pointerdown", onJump));

  const onNameChange = () => {
    const sanitized = sanitizeName(nameInput.value);
    nameInput.value = sanitized;
    if (!playerRef) return;
    update(playerRef, { name: sanitized }).catch(() => undefined);
    setPresence(`参加中: ${sanitized}`);
  };
  nameInput.addEventListener("input", onNameChange);
  holdHandlers.push(() => nameInput.removeEventListener("input", onNameChange));

  const detachEvents = () => {
    holdHandlers.splice(0).forEach((handler) => handler());
  };

  const init = async () => {
    const snapshot = await get(roomPlayersRef);
    if (!active) return;
    let currentCount = 0;
    if (snapshot.exists()) {
      snapshot.forEach(() => {
        currentCount += 1;
        return false;
      });
    }
    if (currentCount >= MAX_PLAYERS) {
      setStatus("満員です。スクリーンで空きが出るまでお待ちください。", "error");
      setPresence(null);
      return;
    }

    const newRef = push(roomPlayersRef);
    playerRef = newRef;

    const sanitizedName = sanitizeName(nameInput.value);
    nameInput.value = sanitizedName;

    await set(newRef, {
      name: sanitizedName,
      input: { ...inputState },
      joinedAt: serverTimestamp(),
    });

    onDisconnect(newRef).remove();

    setStatus(`参加中: ${sanitizedName}`, "info");
    setPresence(`参加中: ${sanitizedName}`);
  };

  void init().catch(() => {
    setStatus("Firebase接続に失敗しました。設定を確認してください。", "error");
    setPresence(null);
  });

  return cleanup;
};

const initScreen = () => {
  const playersRef = ref(db, `rooms/${ROOM_ID}/players`);
  const players = new Map<string, PlayerActor>();
  const pendingPlayers: Array<{ id: string; data: PlayerData }> = [];
  let sceneRef: Phaser.Scene | null = null;

  const createPlayer = (scene: Phaser.Scene, id: string, data: PlayerData) => {
    const safeName = sanitizeName(data.name);
    const text = scene.add
      .text(0, 0, safeName, {
        fontFamily: "monospace",
        fontSize: "22px",
        color: "#111111",
      })
      .setOrigin(0.5, 0.5);

    scene.physics.add.existing(text);
    const body = text.body as Phaser.Physics.Arcade.Body;
    body.setCollideWorldBounds(true);
    body.setBounce(0);
    body.setDragX(900);
    body.setMaxVelocity(240, 900);
    body.setSize(text.width, text.height, true);
    body.setVelocity(0, 0);
    const spawnX = 120 + Math.random() * 720;
    text.setPosition(spawnX, 80);

    const ground = scene.data.get("ground");
    if (ground) {
      scene.physics.add.collider(text, ground);
    }

    const actor: PlayerActor = {
      id,
      data: {
        name: safeName,
        input: data.input ?? { left: false, right: false, jump: false },
      },
      text,
      body,
      lastJumpAt: 0,
    };

    players.set(id, actor);
  };

  const upsertPlayer = (id: string, data: PlayerData) => {
    if (!sceneRef) {
      pendingPlayers.push({ id, data });
      return;
    }
    if (!players.has(id)) {
      createPlayer(sceneRef, id, data);
      return;
    }
    const actor = players.get(id);
    if (!actor) return;
    const safeName = sanitizeName(data.name);
    if (actor.data.name !== safeName) {
      actor.data.name = safeName;
      actor.text.setText(safeName);
      actor.body.setSize(actor.text.width, actor.text.height, true);
    }
    actor.data.input = data.input ?? { left: false, right: false, jump: false };
  };

  const removePlayer = (id: string) => {
    const actor = players.get(id);
    if (!actor) return;
    actor.text.destroy();
    players.delete(id);
  };

  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    width: 960,
    height: 540,
    backgroundColor: "#ffffff",
    parent: "screen-canvas",
    physics: {
      default: "arcade",
      arcade: {
        gravity: { x: 0, y: 900 },
        debug: false,
      },
    },
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: {
      create(this: Phaser.Scene) {
        sceneRef = this;
        const ground = this.add.rectangle(480, 520, 960, 40, 0x111111);
        this.physics.add.existing(ground, true);
        this.data.set("ground", ground);
        this.physics.world.setBounds(0, 0, 960, 540);

        pendingPlayers.splice(0).forEach((entry) => createPlayer(this, entry.id, entry.data));
      },
      update(this: Phaser.Scene) {
        const now = this.time.now;
        players.forEach((actor) => {
          const input = actor.data.input;
          const body = actor.body;
          if (input.left && !input.right) {
            body.setVelocityX(-200);
          } else if (input.right && !input.left) {
            body.setVelocityX(200);
          } else {
            body.setVelocityX(0);
          }
          if (input.jump && body.blocked.down && now - actor.lastJumpAt > 180) {
            body.setVelocityY(-420);
            actor.lastJumpAt = now;
          }
        });
      },
    },
  };

  game = new Phaser.Game(config);

  const unsubAdds = onChildAdded(playersRef, (snapshot) => {
    const data = snapshot.val() as PlayerData | null;
    if (!data) return;
    upsertPlayer(snapshot.key ?? "", data);
  });
  const unsubChanges = onChildChanged(playersRef, (snapshot) => {
    const data = snapshot.val() as PlayerData | null;
    if (!data) return;
    upsertPlayer(snapshot.key ?? "", data);
  });
  const unsubRemoves = onChildRemoved(playersRef, (snapshot) => {
    if (!snapshot.key) return;
    removePlayer(snapshot.key);
  });

  return () => {
    unsubAdds();
    unsubChanges();
    unsubRemoves();
    players.forEach((actor) => actor.text.destroy());
    players.clear();
  };
};

