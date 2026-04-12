import { render } from "solid-js/web";
import App from "@/components/App";
import { loadSettings } from "@/lib/settings";
import "./style.css";

loadSettings().then(() => {
  render(() => <App />, document.getElementById("root")!);
});
