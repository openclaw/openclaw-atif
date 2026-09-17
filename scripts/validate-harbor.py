#!/usr/bin/env python3

import hashlib
import json
import re
import sys
from pathlib import Path

harbor_root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(harbor_root / "src"))

import pydantic  # noqa: E402
from harbor.models.trajectories import Trajectory  # noqa: E402
from harbor.utils.trajectory_validator import TrajectoryValidator  # noqa: E402

paths = [Path(value).resolve() for value in sys.argv[2:]]
if not paths:
    raise SystemExit("No ATIF files supplied")

def check_media(trajectory, root):
    for step in trajectory["steps"]:
        contents = [step["message"]] + [
            result.get("content") for result in step.get("observation", {}).get("results", [])
        ]
        for content in contents:
            if not isinstance(content, list):
                continue
            for part in content:
                if part["type"] == "text":
                    continue
                location = part["source"]["path"]
                if location.startswith(("https://", "http://", "data:")):
                    continue
                match = re.fullmatch(r"media/([0-9a-f]{64})\.[a-z0-9]+", location)
                if not match:
                    raise SystemExit(f"Unsafe retained media path: {location}")
                media = root / location
                if media.is_symlink() or media.parent.is_symlink() or not media.is_file():
                    raise SystemExit(f"Missing or unsafe retained media: {media}")
                if hashlib.sha256(media.read_bytes()).hexdigest() != match[1]:
                    raise SystemExit(f"Retained media hash mismatch: {media}")
    for child in trajectory.get("subagent_trajectories", []):
        check_media(child, root)


for path in paths:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema_version") != "ATIF-v1.8":
        raise SystemExit(f"{path}: expected ATIF-v1.8")
    trajectory = Trajectory.model_validate(data)
    check_media(data, path.parent)
    validator = TrajectoryValidator()
    if not validator.validate(path, validate_images=True):
        raise SystemExit(f"{path}: {'; '.join(validator.get_errors())}")
    round_trip = trajectory.to_json_dict()
    Trajectory.model_validate(round_trip)
    if round_trip != data:
        raise SystemExit(f"{path}: Harbor round-trip changed the trajectory")
    print(f"validated {path}")

print(f"Harbor commit: {harbor_root.name}")
print(f"Pydantic version: {pydantic.__version__}")
