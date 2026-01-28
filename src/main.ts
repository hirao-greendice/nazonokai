import Phaser from "phaser";

new Phaser.Game({
  type: Phaser.AUTO,
  width: 960,
  height: 540,
  backgroundColor: "#111111",
  parent: "app",
  scene: {
    create() {
      this.add.text(40, 40, "nazonokai", {
        fontSize: "48px",
        color: "#ffffff",
      });
    },
  },
});
