import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { lang, t } from "./i18n";
import { initTheme } from "./theme";

// 첫 화면을 그리기 전에 밝게/어둡게를 정해 깜빡임이 없게
initTheme();
document.documentElement.lang = lang;
document.title = `${t("코드행방")} - ${t("AI가 어디서 무엇을 바꾸는지")}`;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
