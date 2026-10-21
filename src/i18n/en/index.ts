/** 영어 사전: 화면 부분마다 파일을 나눠 두고 여기서 합친다. 열쇠는 한국어 원문 그대로. */
import actions from "./actions";
import agent from "./agent";
import backend from "./backend";
import common from "./common";
import git from "./git";
import ui from "./ui";

/** 이름을 붙여 둬서 같은 열쇠를 서로 다르게 번역한 곳을 테스트가 짚어 줄 수 있게 */
export const parts: Record<string, Record<string, string>> = { common, agent, git, actions, ui, backend };
const en: Record<string, string> = Object.assign({}, ...Object.values(parts));
export default en;
