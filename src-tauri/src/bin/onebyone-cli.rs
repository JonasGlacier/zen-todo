#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn main() {
    if let Err(error) = onebyone_lib::cli::run() {
        eprintln!("{}", serde_json::json!({"ok": false, "error": error}));
        std::process::exit(1);
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn main() {
    eprintln!("onebyone-cli is only supported on desktop platforms");
    std::process::exit(1);
}
