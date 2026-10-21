//! User-facing branding. Storage, bundle identifier and CLI binary stay compatible.
pub fn name() -> String {
    tr!("코드행방", "Code Whereabouts")
}

pub fn tagline() -> String {
    tr!(
        "AI가 어디서 무엇을 바꾸는지",
        "See where AI works and what it changes"
    )
}

pub fn title() -> String {
    format!("{} - {}", name(), tagline())
}

#[cfg(target_os = "macos")]
pub fn menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        app_menu.set_text(name())?;
        while !app_menu.items()?.is_empty() {
            app_menu.remove_at(0)?;
        }
        let about = PredefinedMenuItem::about(
            app,
            Some(&tr!("코드행방 정보", "About Code Whereabouts")),
            Some(AboutMetadata {
                name: Some(name()),
                version: Some(app.package_info().version.to_string()),
                credits: Some(tagline()),
                copyright: app.config().bundle.copyright.clone(),
                ..Default::default()
            }),
        )?;
        app_menu.append_items(&[
            &about,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "settings",
                tr!("설정…", "Settings…"),
                true,
                Some("CmdOrCtrl+,"),
            )?,
            &MenuItem::with_id(
                app,
                "check-updates",
                tr!("업데이트 확인…", "Check for Updates…"),
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some(&tr!("서비스", "Services")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(&tr!("코드행방 가리기", "Hide Code Whereabouts")))?,
            &PredefinedMenuItem::hide_others(app, Some(&tr!("기타 가리기", "Hide Others")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(&tr!("코드행방 종료", "Quit Code Whereabouts")))?,
        ])?;
    }
    Ok(menu)
}

pub fn apply_language(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        window.set_title(&title())?;
    }
    #[cfg(target_os = "macos")]
    app.set_menu(menu(app)?)?;
    Ok(())
}
