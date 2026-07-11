#!/usr/bin/env python3
"""
Blueprint Pipeline — Spec Generator
Reads a completed blueprint JSON → writes a dispatch spec to the mailbox.

Usage:
    python3 spec-generate.py <blueprint.json> --target "Cursor (Claude Sonnet 4.6)" --project "C:\\Core-User\\projects\\games\\godot\\ball-drop-maze\\"

Output: C:\\Core-User\\mailbox\\specs\\YYYYMMDD-HHMM_blueprint-dispatch.md
"""
import sys, os, json, argparse
from datetime import datetime
from pathlib import Path


MAILBOX_SPECS = Path("/mnt/c/Core-User/mailbox/specs")


def load_blueprint(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def generate_spec(bp: dict, target: str, project_path: str) -> str:
    name = bp.get("blueprint_name", bp.get("concept_name", "Untitled"))
    source = bp.get("blueprint_id", "unknown")
    template = bp.get("template", None)
    core = bp.get("core_payload", {})
    foundation = bp.get("foundation", {})
    enhancements = bp.get("enhancements", {})
    polish = bp.get("polish_and_experience", {})
    constraints = bp.get("edge_cases_and_constraints", {})

    lines = []

    # Header
    lines.append(f"# Dispatch Spec: {name}")
    lines.append("")
    lines.append(f"**Target:** {target}")
    lines.append(f"**Project:** {project_path}")
    lines.append(f"**Blueprint:** `{source}`")
    if template:
        lines.append(f"**Template:** `{template}`")
    lines.append("")
    lines.append("---")
    lines.append("")

    # What to build (core payload)
    lines.append("## What to Build")
    lines.append("")
    if core.get("has_primary_driver"):
        pd = core.get("primary_driver_details", {})
        comps = pd.get("components", [])
        alloc = pd.get("allocation", {})
        if comps:
            lines.append("### Core Components")
            for c in comps:
                lines.append(f"- {c}")
        if alloc:
            lines.append("")
            lines.append("### Technical Foundation")
            for k, v in alloc.items():
                lines.append(f"- **{k}:** {v}")
    lines.append("")

    # Foundation
    if foundation.get("requires_infrastructure"):
        lines.append("## Infrastructure")
        lines.append("")
        lines.append(f"- **Platform:** {foundation.get('infrastructure_type', 'See above')}")
        lines.append(f"- **Scale:** {foundation.get('scale_or_quantity', 'TBD')}")
        lines.append("")

    # Features
    features = enhancements.get("feature_list", [])
    if features:
        lines.append("## Features to Build")
        lines.append("")
        for f in features:
            lines.append(f"- {f}")
        lines.append("")

    # Polish
    if polish.get("has_refinements"):
        lines.append("## Polish & Experience")
        lines.append("")
        lines.append(f"- **Refinements:** {polish.get('refinement_type', '')}")
        lines.append(f"- **Metrics:** {polish.get('intensity_or_volume', '')}")
        lines.append("")

    # Hard constraints
    rules = constraints.get("execution_rules", [])
    if rules:
        lines.append("## ⛔ Hard Constraints — DO NOT VIOLATE")
        lines.append("")
        for r in rules:
            lines.append(f"- {r}")
        lines.append("")

    # Delivery checklist
    lines.append("---")
    lines.append("")
    lines.append("## Delivery Checklist")
    lines.append("")
    lines.append("- [ ] All core components implemented")
    lines.append("- [ ] Infrastructure matches spec")
    lines.append("- [ ] All features built")
    lines.append("- [ ] Polish refinements complete")
    lines.append("- [ ] No hard constraints violated")
    lines.append("- [ ] Project builds and runs without errors")
    lines.append("- [ ] Results written to `mailbox/results/`")
    lines.append("")

    # Footer
    lines.append("---")
    lines.append(f"*Generated {datetime.now().strftime('%Y-%m-%d %H:%M')} UTC*")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Generate a dispatch spec from a blueprint")
    parser.add_argument("blueprint", help="Path to completed blueprint JSON")
    parser.add_argument("--target", required=True, help="Target agent (e.g. 'Cursor (Claude Sonnet 4.6)')")
    parser.add_argument("--project", required=True, help="Target project path")
    args = parser.parse_args()

    bp = load_blueprint(args.blueprint)
    spec = generate_spec(bp, args.target, args.project)

    # Write to mailbox
    MAILBOX_SPECS.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M")
    name_slug = bp.get("blueprint_id", "blueprint")
    filename = f"{timestamp}_{name_slug}-dispatch.md"
    outpath = MAILBOX_SPECS / filename
    outpath.write_text(spec, encoding="utf-8")

    print(f"Spec written: {outpath}")
    print(f"Lines: {len(spec.splitlines())}")

    # Also print to stdout so the caller can see it
    print()
    print("───", filename, "─" * (60 - len(filename)))
    print(spec)


if __name__ == "__main__":
    main()
