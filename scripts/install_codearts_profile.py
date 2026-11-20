"""把 dsh-connect-codearts 以 link 依赖装进 desktop profile，并登记为 bundle。

用法: python install_codearts_profile.py [--uninstall]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

PROFILE = Path.home() / ".dsh" / "profiles" / "desktop"
PKG = PROFILE / "package.json"
# 项目目录 = 本脚本所在目录的上一级。不写死本机路径，一是这个脚本会进公开
# 仓库（check-pii 会拦真实用户名），二是别人 clone 到别处也能直接用。
PROJECT = Path(__file__).resolve().parent.parent
NAME = "dsh-connect-codearts"
SPEC = "link:" + str(PROJECT).replace("\\", "/")


def main() -> int:
    uninstall = "--uninstall" in sys.argv
    doc = json.loads(PKG.read_text(encoding="utf-8"))

    deps = doc.setdefault("dependencies", {})
    bundles = doc.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])

    if uninstall:
        deps.pop(NAME, None)
        while NAME in bundles:
            bundles.remove(NAME)
        action = "removed"
    else:
        deps[NAME] = SPEC
        if NAME not in bundles:
            bundles.append(NAME)
        action = "installed"

    PKG.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{action}: {NAME} -> {SPEC}")
    print(f"dependencies count = {len(deps)}, bundles count = {len(bundles)}")
    print("bundles tail:", bundles[-3:])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
