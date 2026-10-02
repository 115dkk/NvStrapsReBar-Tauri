import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import "./styles.css";
import "./workspace-layout.css";
import "./guided/guided.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
        <StrictMode>
                <I18nProvider><App /></I18nProvider>
        </StrictMode>,
);
