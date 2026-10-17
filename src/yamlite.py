#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Tiny YAML subset parser (Python 2.7 compatible) - enough for Clash configs.

Supports: block mappings, block sequences, nested indentation, inline flow
maps/lists (one level, with quoting), comments, anchors (&name) and aliases
(*name), multi-line plain scalars are not supported (not used here).
"""
import re

_SCALAR_NUM = re.compile(r"^-?\d+$")


def _flow_scalar(text):
    text = text.strip()
    if not text:
        return ""
    if text in ("true", "True"):
        return True
    if text in ("false", "False"):
        return False
    if text in ("null", "Null", "~", ""):
        return None
    if _SCALAR_NUM.match(text):
        try:
            return int(text)
        except ValueError:
            return text
    if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
        body = text[1:-1]
        if text[0] == '"':
            body = body.replace('\\"', '"').replace("\\n", "\n")
        return body
    return text


def _split_top(text, sep=","):
    """Split on `sep` ignoring separators inside quotes/brackets."""
    out, depth, cur, quote = [], 0, "", None
    for ch in text:
        if quote:
            cur += ch
            if ch == quote:
                quote = None
            continue
        if ch in "\"'":
            quote = ch
            cur += ch
            continue
        if ch in "{[":
            depth += 1
        elif ch in "}]":
            depth -= 1
        if ch == sep and depth == 0:
            out.append(cur)
            cur = ""
            continue
        cur += ch
    if cur.strip():
        out.append(cur)
    return out


def _parse_flow(text, anchors=None):
    text = text.strip()
    if text.startswith("{"):
        body = text[1:-1] if text.endswith("}") else text[1:]
        out = {}
        for part in _split_top(body):
            if ":" not in part:
                continue
            k, v = part.split(":", 1)
            key = _flow_scalar(k)
            val = v.strip()
            if val.startswith("{") or val.startswith("["):
                out[key] = _parse_flow(val, anchors)
            else:
                out[key] = _flow_scalar(val)
        return out
    if text.startswith("["):
        body = text[1:-1] if text.endswith("]") else text[1:]
        items = []
        for part in _split_top(body):
            part = part.strip()
            if part.startswith("{") or part.startswith("["):
                items.append(_parse_flow(part, anchors))
            else:
                items.append(_flow_scalar(part))
        return items
    return _flow_scalar(text)


def _strip_comment(line):
    out, quote = "", None
    for i, ch in enumerate(line):
        if quote:
            out += ch
            if ch == quote:
                quote = None
            continue
        if ch in "\"'":
            quote = ch
            out += ch
            continue
        if ch == "#" and (i == 0 or line[i - 1] in " \t"):
            break
        out += ch
    return out.rstrip()


class _Node(object):
    def __init__(self):
        self.map = {}
        self.seq = []
        self.is_seq = False


def load(text):
    """Parse a YAML document into dicts/lists (subset)."""
    anchors = {}
    root = _Node()
    stack = [(-1, root)]
    last_key = {}       # id(node) -> key awaiting a nested block
    pending_seq = {}    # id(node) -> True once it holds seq items

    lines = [_strip_comment(l) for l in text.replace("\r\n", "\n").split("\n")]

    for raw in lines:
        if not raw.strip() or raw.strip() in ("---", "..."):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        body = raw.strip()
        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]

        # sequence item
        if body.startswith("- "):
            body = body[2:].strip()
            if not parent.is_seq and not parent.map and not parent.seq:
                parent.is_seq = True
            item = _Node()
            item.is_seq = False
            # an item that is itself a mapping on the same line: "- key: value"
            if ":" in body and not body.startswith("{") and not body.startswith("["):
                k, v = body.split(":", 1)
                k = _flow_scalar(k)
                v = v.strip()
                if v.startswith("&"):
                    anchors[v[1:].split()[0]] = item
                    v = v.split(" ", 1)[1] if " " in v else ""
                if v == "":
                    item.map[k] = None
                    last_key[id(item)] = k
                elif v.startswith("{") or v.startswith("["):
                    item.map[k] = _parse_flow(v, anchors)
                else:
                    item.map[k] = _flow_scalar(v)
            elif body.startswith("{") or body.startswith("["):
                item = _parse_flow(body, anchors)
            elif body.startswith("&"):
                anchors[body[1:].split()[0]] = item
            elif body.startswith("*"):
                item = anchors.get(body[1:], "")
            else:
                item = _flow_scalar(body)
            parent.seq.append(item)
            parent.is_seq = True
            if isinstance(item, _Node):
                stack.append((indent, item))
            continue

        if ":" not in body:
            continue
        k, v = body.split(":", 1)
        k = _flow_scalar(k)
        v = v.strip()
        if parent.is_seq:
            continue
        if v.startswith("&") and (len(v) == 1 or v.startswith("&") and " " in v and not v.startswith("&{") and len(v.split()) > 1):
            pass
        if v.startswith("&"):
            parts = v.split()
            anchor_name = parts[0][1:]
            rest = v[len(parts[0]):].strip()
            if rest:
                child = _parse_flow(rest, anchors) if rest[0] in "{[" else _flow_scalar(rest)
                anchors[anchor_name] = child
                parent.map[k] = child
            else:
                child = _Node()
                anchors[anchor_name] = child
                parent.map[k] = child
                stack.append((indent, child))
                last_key[id(child)] = k
            continue
        if v.startswith("*"):
            parent.map[k] = anchors.get(v[1:], None)
            continue
        if v == "":
            child = _Node()
            parent.map[k] = child
            stack.append((indent, child))
            last_key[id(child)] = k
            continue
        if v.startswith("{") or v.startswith("["):
            parent.map[k] = _parse_flow(v, anchors)
            continue
        parent.map[k] = _flow_scalar(v)

    def finish(node):
        if isinstance(node, _Node):
            if node.is_seq:
                return [finish(x) for x in node.seq]
            return dict((k, finish(v)) for k, v in node.map.items())
        if isinstance(node, list):
            return [finish(x) for x in node]
        if isinstance(node, dict):
            return dict((k, finish(v)) for k, v in node.items())
        return node

    return finish(root)
