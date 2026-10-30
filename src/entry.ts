if (new URLSearchParams(window.location.search).get("view") === "settings") {
  void import("./settings");
} else {
  void import("./main");
}
