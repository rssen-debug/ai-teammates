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


def evaluate(board, cleared):
    heights = []
    holes = 0
    for x in range(WIDTH):
        first = next((y for y in range(HEIGHT) if board[y][x]), HEIGHT)
        heights.append(HEIGHT - first)
        holes += sum(not board[y][x] for y in range(first, HEIGHT))
    roughness = sum(abs(a-b) for a,b in zip(heights, heights[1:]))
    return 12.0 * cleared - 0.8 * sum(heights) - 5.0 * holes - 0.4 * roughness


class PixelTetris:
    """Game physics and a reproducible heuristic autoplayer, not an AI result."""

    def __init__(self, seed=None):
        self.rng = random.Random(seed)
        self.board = [[0] * WIDTH for _ in range(HEIGHT)]
        self.score = 0
        self.lines = 0
        self.pieces = 0
        self.games = 0
        self.active = None
        self.x = 0
        self.y = 0
        self.spawn()

    def _target(self, cells):
        best = None
        for rotation in rotations(cells):
            width = max(x for x, _ in rotation) + 1
            for x in range(WIDTH - width + 1):
                y = -2
                if not fits(self.board, rotation, x, y):
                    continue
                while fits(self.board, rotation, x, y + 1):
                    y += 1
                if any(y + dy < 0 for _, dy in rotation):
                    continue
                projected = [row[:] for row in self.board]
                for dx, dy in rotation:
                    projected[y + dy][x + dx] = 1
                remaining, cleared = clear_rows(projected)
                value = evaluate(remaining, cleared)
                if best is None or value > best[0]:
                    best = (value, rotation, x)
        return best

    def spawn(self):
        cells = self.rng.choice(SHAPES)
        target = self._target(cells)
        if target is None:
            self.games += 1
            self.board = [[0] * WIDTH for _ in range(HEIGHT)]
            target = self._target(cells)
        if target is None:
            raise RuntimeError("tetromino cannot enter an empty board")
        _, self.active, self.x = target
        self.y = -2

    def tick(self):
        if self.active is None:
            self.spawn()
        if fits(self.board, self.active, self.x, self.y + 1):
            self.y += 1
            return "fall"
        for dx, dy in self.active:
            x, y = self.x + dx, self.y + dy
            if y < 0:
                # A top-out is an actual game-over event, not a level-up.
                self.games += 1
                self.board = [[0] * WIDTH for _ in range(HEIGHT)]
                self.active = None
                self.spawn()
                return "game_over"
            self.board[y][x] = 1
        self.board, cleared = clear_rows(self.board)
        self.pieces += 1
        self.lines += cleared
        self.score += (0, 100, 300, 500, 800)[min(4, cleared)]
        self.active = None
        self.spawn()
        return "clear" if cleared else "lock"

    def display(self):
        display = [row[:] for row in self.board]
        if self.active is not None:
            for dx, dy in self.active:
                x, y = self.x + dx, self.y + dy
                if 0 <= y < HEIGHT and 0 <= x < WIDTH:
                    display[y][x] = 2
        return tuple("".join("▓" if value == 1 else "■" if value == 2 else "·" for value in row)
                     for row in display)
