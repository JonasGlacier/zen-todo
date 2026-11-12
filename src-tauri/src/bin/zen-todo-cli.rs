fn main() {
    if let Err(error) = zen_todo_lib::cli::run() {
        eprintln!("{}", serde_json::json!({"ok": false, "error": error}));
        std::process::exit(1);
    }
}
