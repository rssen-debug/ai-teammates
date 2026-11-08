"""A real, bounded Tetris simulation for OMEGA's optional pixel sidebar.

This game is independent of the AI model and of the verified AI LEVEL metric.
Its moving blocks are actual game state, never a fake agent action trace.
"""
from __future__ import annotations
import random

WIDTH = 10
HEIGHT = 12
SHAPES = (
    ((0, 0), (1, 0), (2, 0), (3, 0)),  # I
    ((0, 0), (1, 0), (0, 1), (1, 1)),  # O
    ((0, 0), (1, 0), (2, 0), (1, 1)),  # T
    ((0, 0), (1, 0), (1, 1), (2, 1)),  # Z
    ((1, 0), (2, 0), (0, 1), (1, 1)),  # S
    ((0, 0), (0, 1), (1, 1), (2, 1)),  # L
    ((2, 0), (0, 1), (1, 1), (2, 1)),  # J
)

def rotations(points):
    """Return distinct quarter turns, normalized to the upper left."""
    result = []
    cur = tuple(points)
    for _ in range(4):
        min_x = min(x for x, _ in cur)
        min_y = min(y for _, y in cur)
        norm = tuple(sorted((x - min_x, y - min_y) for x, y in cur))
        if norm not in result:
            result.append(norm)
        cur = tuple((-y, x) for x, y in cur)
    return tuple(result)


def fits(board, cells, px, py):
    for dx, dy in cells:
        x, y = px + dx, py + dy
        if x < 0 or x >= WIDTH or y >= HEIGHT:
            return False
        if y >= 0 and board[y][x]:
            return False
    return True


def clear_rows(board):
    remaining = [row[:] for row in board if not all(row)]
    count = HEIGHT - len(remaining)
    return [[0] * WIDTH for _ in range(count)] + remaining, count


class PixelTetris:
    """Physics-only Tetris. A real model must choose each legal placement."""
    def __init__(self, seed=None):
        self.rng = random.Random(seed)
        self.board = [[0] * WIDTH for _ in range(HEIGHT)]
        self.score = 0
        self.lines = 0
        self.pieces = 0
        self.games = 0
        self.active = None
        self.shape = None
        self.x = 0
        self.y = -2
        self.awaiting_move = True
        self.spawn()

    def choices(self):
        if self.shape is None:
            return []
        moves = []
        for rotated in rotations(self.shape):
            width = max(x for x, _ in rotated) + 1
            for x in range(WIDTH - width + 1):
                landing = -2
                if not fits(self.board, rotated, x, landing):
                    continue
                while fits(self.board, rotated, x, landing + 1):
                    landing += 1
                if any(landing + dy < 0 for _, dy in rotated):
                    continue
                moves.append({"id": len(moves), "cells": rotated,
                              "x": x, "landing": landing})
        return moves

    def spawn(self):
        self.shape = self.rng.choice(SHAPES)
        self.active = self.shape
        self.x, self.y = 3, -2
        self.awaiting_move = True
        if not self.choices():
            self.games += 1
            self.board = [[0] * WIDTH for _ in range(HEIGHT)]
            self.shape = self.rng.choice(SHAPES)
            self.active = self.shape
            self.x, self.y = 3, -2

    def choose(self, move_id):
        if not self.awaiting_move:
            return False
        for candidate in self.choices():
            if type(move_id) is int and candidate["id"] == move_id:
                self.active = candidate["cells"]
                self.x = candidate["x"]
                self.y = -2
                self.awaiting_move = False
                return True
        return False

    def tick(self):
        if self.awaiting_move:
            return "waiting_ai"
        if fits(self.board, self.active, self.x, self.y + 1):
            self.y += 1
            return "fall"
        for dx, dy in self.active:
            x, y = self.x + dx, self.y + dy
            if y < 0:
                self.games += 1
                self.board = [[0] * WIDTH for _ in range(HEIGHT)]
                self.spawn()
                return "game_over"
            self.board[y][x] = 1
        self.board, cleared = clear_rows(self.board)
        self.pieces += 1
        self.lines += cleared
        self.score += (0, 100, 300, 500, 800)[min(4, cleared)]
        self.spawn()
        return "clear" if cleared else "lock"

    def display(self):
        display = [row[:] for row in self.board]
        if self.awaiting_move and self.shape is not None:
            # Static preview of the real queued piece. No gravity/moves are
            # applied until an actual valid Kilo decision arrives.
            for dx, dy in self.shape:
                x, y = 3 + dx, dy
                if 0 <= y < HEIGHT and 0 <= x < WIDTH:
                    display[y][x] = 3
        elif self.active is not None:
            for dx, dy in self.active:
                x, y = self.x + dx, self.y + dy
                if 0 <= y < HEIGHT and 0 <= x < WIDTH:
                    display[y][x] = 2
        return tuple("".join(
            "▓" if value == 1 else "■" if value == 2 else "◇" if value == 3 else "·"
            for value in row) for row in display)
