"""Pixel Tetris is real game logic, separate from AI evidence and model calls."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pixel_tetris import PixelTetris, WIDTH, HEIGHT, SHAPES, rotations, clear_rows, fits


class PixelTetrisTest(unittest.TestCase):
    def test_seven_real_tetrominoes_and_rotations(self):
        self.assertEqual(len(SHAPES), 7)
        for shape in SHAPES:
            self.assertEqual(len(set(shape)), 4)
            for rotated in rotations(shape):
                self.assertEqual(len(set(rotated)), 4)
                self.assertTrue(all(x >= 0 and y >= 0 for x, y in rotated))

    def test_gravity_moves_live_piece_and_locks_to_board(self):
        game = PixelTetris(seed=43)
        before = game.y
        self.assertEqual(game.tick(), "waiting_ai")
        self.assertEqual(game.y, before)
        self.assertTrue(game.choose(game.choices()[0]["id"]))
        self.assertEqual(game.tick(), "fall")
        self.assertEqual(game.y, before + 1)
        for _ in range(40):
            game.tick()
            if game.pieces:
                break
        self.assertEqual(game.pieces, 1)
        self.assertGreater(sum(map(sum, game.board)), 0)

    def test_game_cannot_play_without_external_model_choice(self):
        game = PixelTetris(seed=10)
        start = game.display()
        for _ in range(50):
            self.assertEqual(game.tick(), "waiting_ai")
        self.assertEqual(game.display(), start)
        self.assertEqual(game.pieces, 0)

    def test_invalid_model_choice_never_moves_piece(self):
        game = PixelTetris(seed=10)
        self.assertFalse(game.choose(9999999))
        self.assertFalse(game.choose(True))
        self.assertTrue(game.awaiting_move)
        self.assertEqual(game.tick(), "waiting_ai")
        legal = game.choices()
        self.assertGreater(len(legal), 0)
        self.assertTrue(game.choose(legal[-1]["id"]))
        self.assertFalse(game.awaiting_move)
        self.assertFalse(game.choose(legal[0]["id"]))

    def test_line_clear_is_real(self):
        board = [[0] * WIDTH for _ in range(HEIGHT)]
        board[-1] = [1] * WIDTH
        board[-2][4] = 1
        new, count = clear_rows(board)
        self.assertEqual(count, 1)
        self.assertEqual(sum(map(sum, new)), 1)
        self.assertEqual(new[-1][4], 1)

    def test_collision_and_top_boundary(self):
        board = [[0] * WIDTH for _ in range(HEIGHT)]
        piece = SHAPES[1]
        self.assertTrue(fits(board, piece, 2, -1))
        self.assertFalse(fits(board, piece, -1, 0))
        self.assertFalse(fits(board, piece, 9, 0))
        board[3][2] = 1
        self.assertFalse(fits(board, piece, 2, 3))

    def test_live_board_is_generated_from_state_not_static_art(self):
        game = PixelTetris(seed=1)
        first = game.display()
        self.assertEqual(len(first), HEIGHT)
        self.assertEqual({len(row) for row in first}, {WIDTH})
        snapshots = {first}
        for _ in range(30):
            if game.awaiting_move:
                game.choose(game.choices()[0]["id"])
            game.tick()
            snapshots.add(game.display())
        self.assertGreater(len(snapshots), 3)
        self.assertGreater(game.pieces, 0)

    def test_game_score_is_independent_from_agent_level(self):
        game = PixelTetris(seed=3)
        self.assertFalse(hasattr(game, "ai_level"))
        self.assertFalse(hasattr(game, "verified_evidence"))
        for _ in range(100):
            if game.awaiting_move:
                game.choose(game.choices()[0]["id"])
            game.tick()
        self.assertGreater(game.pieces, 0)


if __name__ == "__main__":
    unittest.main()
