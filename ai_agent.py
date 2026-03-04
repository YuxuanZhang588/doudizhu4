"""
AI Agent for 4-player Doudizhu using trained DouZero4 models.
Provides inference for web app integration.
"""
import os
import sys
from pathlib import Path
from collections import Counter
import numpy as np
import torch
from torch import nn

DOUZERO4_ROOT = Path(__file__).resolve().parent.parent / "DouZero4"
if DOUZERO4_ROOT.exists() and str(DOUZERO4_ROOT) not in sys.path:
    sys.path.insert(0, str(DOUZERO4_ROOT))

# DouZero project root (transformer branch, attn_v1 checkpoints)
DOUZERO_ROOT = Path(__file__).resolve().parent.parent / "DouZero4"

# Model info exposed via /api/model_info
MODEL_INFO = {}

from douzero.env.move_generator import MovesGener
from douzero.env import move_detector as md, move_selector as ms

# Card to column mapping for feature encoding (13 ranks, no jokers)
Card2Column = {3: 0, 4: 1, 5: 2, 6: 3, 7: 4, 8: 5, 9: 6, 10: 7,
               11: 8, 12: 9, 13: 10, 14: 11, 17: 12}

NumOnes2Array = {0: np.array([0, 0, 0, 0]),
                 1: np.array([1, 0, 0, 0]),
                 2: np.array([1, 1, 0, 0]),
                 3: np.array([1, 1, 1, 0]),
                 4: np.array([1, 1, 1, 1])}

# Card rank mappings
RealCard2EnvCard = {'3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
                    '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12,
                    'K': 13, 'A': 14, '2': 17}

EnvCard2RealCard = {v: k for k, v in RealCard2EnvCard.items()}

# Positions in 4-player game
POSITIONS = ['landlord', 'landlord_next', 'landlord_across', 'landlord_prev']


class LandlordLstmModel(nn.Module):
    """Landlord model for 4-player Doudizhu."""
    def __init__(self):
        super().__init__()
        self.lstm = nn.LSTM(208, 128, batch_first=True)
        self.dense1 = nn.Linear(546, 512)
        self.dense2 = nn.Linear(512, 512)
        self.dense3 = nn.Linear(512, 512)
        self.dense4 = nn.Linear(512, 512)
        self.dense5 = nn.Linear(512, 512)
        self.dense6 = nn.Linear(512, 1)

    def forward(self, z, x, return_value=False, flags=None):
        lstm_out, (h_n, _) = self.lstm(z)
        lstm_out = lstm_out[:, -1, :]
        x = torch.cat([lstm_out, x], dim=-1)
        x = self.dense1(x)
        x = torch.relu(x)
        x = self.dense2(x)
        x = torch.relu(x)
        x = self.dense3(x)
        x = torch.relu(x)
        x = self.dense4(x)
        x = torch.relu(x)
        x = self.dense5(x)
        x = torch.relu(x)
        x = self.dense6(x)
        if return_value:
            return dict(values=x)
        else:
            action = torch.argmax(x, dim=0)[0]
            return dict(action=action)


class FarmerLstmModel(nn.Module):
    """Farmer model for 4-player Doudizhu."""
    def __init__(self):
        super().__init__()
        self.lstm = nn.LSTM(208, 128, batch_first=True)
        self.dense1 = nn.Linear(550, 512)
        self.dense2 = nn.Linear(512, 512)
        self.dense3 = nn.Linear(512, 512)
        self.dense4 = nn.Linear(512, 512)
        self.dense5 = nn.Linear(512, 512)
        self.dense6 = nn.Linear(512, 1)

    def forward(self, z, x, return_value=False, flags=None):
        lstm_out, (h_n, _) = self.lstm(z)
        lstm_out = lstm_out[:, -1, :]
        x = torch.cat([lstm_out, x], dim=-1)
        x = self.dense1(x)
        x = torch.relu(x)
        x = self.dense2(x)
        x = torch.relu(x)
        x = self.dense3(x)
        x = torch.relu(x)
        x = self.dense4(x)
        x = torch.relu(x)
        x = self.dense5(x)
        x = torch.relu(x)
        x = self.dense6(x)
        if return_value:
            return dict(values=x)
        else:
            action = torch.argmax(x, dim=0)[0]
            return dict(action=action)


def _cards2array(list_cards):
    """Transform a list of card integers into a 52-dimensional array."""
    if len(list_cards) == 0:
        return np.zeros(52, dtype=np.int8)
    
    matrix = np.zeros([4, 13], dtype=np.int8)
    counter = Counter(list_cards)
    for card, num_times in counter.items():
        if card in Card2Column:
            matrix[:, Card2Column[card]] = NumOnes2Array[num_times]
    return matrix.flatten('F')


def _action_seq_list2array(action_seq_list):
    """Encode historical moves for LSTM input."""
    action_seq_array = np.zeros((len(action_seq_list), 52))
    for row, list_cards in enumerate(action_seq_list):
        action_seq_array[row, :] = _cards2array(list_cards)
    action_seq_array = action_seq_array.reshape(5, 208)
    return action_seq_array


def _process_action_seq(sequence, length=20):
    """Process action sequence for LSTM encoding."""
    sequence = sequence[-length:].copy()
    if len(sequence) < length:
        empty_sequence = [[] for _ in range(length - len(sequence))]
        empty_sequence.extend(sequence)
        sequence = empty_sequence
    return sequence


def _process_action_seq_v2(sequence, length=32):
    """Process action sequence for transformer encoding (32 tokens)."""
    sequence = sequence[-length:].copy()
    if len(sequence) < length:
        empty_sequence = [[] for _ in range(length - len(sequence))]
        empty_sequence.extend(sequence)
        sequence = empty_sequence
    return sequence


def _action_seq_list2array_transformer(action_seq_list):
    """Encode action sequence as (32, 52) array for transformer z-encoder."""
    action_seq_array = np.zeros((len(action_seq_list), 52), dtype=np.float32)
    for row, list_cards in enumerate(action_seq_list):
        action_seq_array[row, :] = _cards2array(list_cards)
    return action_seq_array  # shape (32, 52)


def _get_one_hot_array(num_left_cards, max_num_cards):
    """One-hot encoding of card counts."""
    one_hot = np.zeros(max_num_cards)
    if num_left_cards > 0:
        one_hot[num_left_cards - 1] = 1
    return one_hot


def _get_one_hot_bomb(bomb_num):
    """One-hot encode the number of bombs played."""
    one_hot = np.zeros(15)
    one_hot[min(bomb_num, 14)] = 1
    return one_hot


class AIAgent:
    """AI agent that uses trained DouZero4 models for decision making."""
    
    def __init__(self, checkpoint_dir):
        """
        Initialize AI agent by loading trained models.
        
        Args:
            checkpoint_dir: Path to directory containing .ckpt files
        """
        self.checkpoint_dir = Path(checkpoint_dir)
        self.device = torch.device('cpu')  # Pi doesn't have CUDA
        self.models = {}
        
        print(f"Loading models from {self.checkpoint_dir}")
        self._load_models()
        print("Models loaded successfully")
    
    def _load_models(self):
        """Load all four position models."""
        # Model architecture mapping
        model_classes = {
            'landlord': LandlordLstmModel,
            'landlord_next': FarmerLstmModel,
            'landlord_across': FarmerLstmModel,
            'landlord_prev': FarmerLstmModel,
        }
        
        for position in POSITIONS:
            # Find checkpoint file
            checkpoint_files = list(self.checkpoint_dir.glob(f"{position}_weights_*.ckpt"))
            if not checkpoint_files:
                raise FileNotFoundError(f"No checkpoint found for {position}")
            
            checkpoint_path = checkpoint_files[0]
            print(f"  Loading {position} from {checkpoint_path.name}")
            
            # Create model
            model = model_classes[position]()
            
            # Load weights
            model_state_dict = model.state_dict()
            pretrained = torch.load(checkpoint_path, map_location=self.device)
            pretrained = {k: v for k, v in pretrained.items() if k in model_state_dict}
            model_state_dict.update(pretrained)
            model.load_state_dict(model_state_dict)
            
            model.to(self.device)
            model.eval()
            self.models[position] = model
    
    def get_action(self, game_state, player_position):
        """
        Get best action for given game state and player.
        
        Args:
            game_state: Dict containing game state from web app
            player_position: Player index 0-3 (0 is human, 1-3 are AIs)
            
        Returns:
            List of cards to play (in JS format), or None for pass
        """
        try:
            # Convert game state to model format
            obs = self._convert_state(game_state, player_position)
            
            if obs is None or len(obs['legal_actions']) == 0:
                return None
            
            # If only one legal action (must pass or only one move), return it
            if len(obs['legal_actions']) == 1:
                action_cards = obs['legal_actions'][0]
                return self._cards_to_js(action_cards)
            
            # Get model prediction
            position = obs['position']
            model = self.models[position]
            
            z_batch = torch.from_numpy(obs['z_batch']).float().to(self.device)
            x_batch = torch.from_numpy(obs['x_batch']).float().to(self.device)
            
            with torch.no_grad():
                y_pred = model.forward(z_batch, x_batch, return_value=True)['values']
            
            y_pred = y_pred.cpu().numpy()
            best_action_index = np.argmax(y_pred, axis=0)[0]
            best_action = obs['legal_actions'][best_action_index]
            
            return self._cards_to_js(best_action)
            
        except Exception as e:
            print(f"Error in AI agent: {e}")
            import traceback
            traceback.print_exc()
            return None
    
    def _convert_state(self, game_state, player_position):
        """
        Convert web app game state to DouZero4 observation format.
        
        Args:
            game_state: Game state dict from web app
            player_position: Player index 0-3
            
        Returns:
            Observation dict with x_batch, z_batch, legal_actions, position
        """
        # Determine which model to use based on game state
        landlord_idx = game_state.get('landlord')
        if landlord_idx is None:
            return None  # Game not started yet
        
        # Map player position to DouZero4 position name
        position = self._get_douzero_position(player_position, landlord_idx)
        
        # Convert hands to integer cards
        hands_int = []
        for hand in game_state['hands']:
            hand_int = [RealCard2EnvCard[card['r']] for card in hand]
            hand_int.sort()
            hands_int.append(hand_int)
        
        my_hand = hands_int[player_position]
        
        # Generate legal actions using DouZero4 native move generation
        legal_actions = self._generate_legal_actions(my_hand, game_state)
        
        if len(legal_actions) == 0:
            legal_actions = [[]]  # Must pass
        
        # Build observation features
        obs = self._build_observation(
            position=position,
            my_hand=my_hand,
            hands_int=hands_int,
            player_position=player_position,
            landlord_idx=landlord_idx,
            game_state=game_state,
            legal_actions=legal_actions
        )
        
        return obs
    
    def _get_douzero_position(self, player_idx, landlord_idx):
        """Map player index to DouZero4 position name."""
        if player_idx == landlord_idx:
            return 'landlord'
        
        # Calculate offset from landlord (clockwise)
        offset = (player_idx - landlord_idx) % 4
        if offset == 1:
            return 'landlord_next'
        elif offset == 2:
            return 'landlord_across'
        else:  # offset == 3
            return 'landlord_prev'
    
    def _get_rival_move_from_events(self, game_state):
        """
        Rebuild the rival move strictly from events, following DouZero semantics:
        - Use the most recent non-pass play in the current trick.
        - If trick has been reset (trick_reset event), rival move is searched after that point.
        """
        events = game_state.get('events', []) or []

        # Find last trick reset boundary
        last_reset_idx = -1
        for idx, event in enumerate(events):
            if isinstance(event, dict) and event.get('type') == 'trick_reset':
                last_reset_idx = idx

        # Search backwards for the latest non-pass play after last reset
        for event in reversed(events[last_reset_idx + 1:]):
            if not isinstance(event, dict):
                continue
            if event.get('type') != 'play':
                continue
            cards = event.get('cards') or []
            if not cards:
                continue

            rival_move = []
            for card in cards:
                rank = card.get('r') if isinstance(card, dict) else None
                if rank in RealCard2EnvCard:
                    rival_move.append(RealCard2EnvCard[rank])
            rival_move.sort()
            return rival_move

        return []

    def _generate_legal_actions(self, my_hand, game_state):
        """
        Generate legal actions from hand using DouZero4 move generator.
        Mirrors douzero.env.game.GameEnv.get_legal_card_play_actions logic.
        """
        mg = MovesGener(my_hand)
        rival_move = self._get_rival_move_from_events(game_state)

        rival_type = md.get_move_type(rival_move)
        rival_move_type = rival_type['type']
        rival_move_len = rival_type.get('len', 1)
        moves = []

        if rival_move_type == md.TYPE_0_PASS:
            moves = mg.gen_moves()

        elif rival_move_type == md.TYPE_1_SINGLE:
            all_moves = mg.gen_type_1_single()
            moves = ms.filter_type_1_single(all_moves, rival_move)

        elif rival_move_type == md.TYPE_2_PAIR:
            all_moves = mg.gen_type_2_pair()
            moves = ms.filter_type_2_pair(all_moves, rival_move)

        elif rival_move_type == md.TYPE_3_TRIPLE:
            all_moves = mg.gen_type_3_triple()
            moves = ms.filter_type_3_triple(all_moves, rival_move)

        elif rival_move_type == md.TYPE_4_BOMB:
            all_moves = mg.gen_type_4_bomb()
            moves = ms.filter_type_4_bomb(all_moves, rival_move)

        elif rival_move_type == md.TYPE_6_3_1:
            all_moves = mg.gen_type_6_3_1()
            moves = ms.filter_type_6_3_1(all_moves, rival_move)

        elif rival_move_type == md.TYPE_8_SERIAL_SINGLE:
            all_moves = mg.gen_type_8_serial_single(repeat_num=rival_move_len)
            moves = ms.filter_type_8_serial_single(all_moves, rival_move)

        elif rival_move_type == md.TYPE_9_SERIAL_PAIR:
            all_moves = mg.gen_type_9_serial_pair(repeat_num=rival_move_len)
            moves = ms.filter_type_9_serial_pair(all_moves, rival_move)

        elif rival_move_type == md.TYPE_10_SERIAL_TRIPLE:
            all_moves = mg.gen_type_10_serial_triple(repeat_num=rival_move_len)
            moves = ms.filter_type_10_serial_triple(all_moves, rival_move)

        elif rival_move_type == md.TYPE_11_SERIAL_3_1:
            all_moves = mg.gen_type_11_serial_3_1(repeat_num=rival_move_len)
            moves = ms.filter_type_11_serial_3_1(all_moves, rival_move)

        if rival_move_type not in [md.TYPE_0_PASS, md.TYPE_4_BOMB]:
            moves = moves + mg.gen_type_4_bomb()

        if len(rival_move) != 0:
            moves = moves + [[]]

        for move in moves:
            move.sort()

        if len(moves) == 0:
            return [[]]
        return moves
    
    def _build_observation(self, position, my_hand, hands_int, player_position, 
                          landlord_idx, game_state, legal_actions):
        """Build observation features for model input."""
        num_legal_actions = len(legal_actions)
        
        # My hand cards
        my_handcards = _cards2array(my_hand)
        my_handcards_batch = np.repeat(my_handcards[np.newaxis, :],
                                       num_legal_actions, axis=0)
        
        # Calculate other hand cards (all cards not in my hand and not played)
        all_cards = []
        for i in range(3, 15):
            all_cards.extend([i] * 4)
        all_cards.extend([17] * 4)  # Four 2s
        
        # Remove my cards
        for card in my_hand:
            if card in all_cards:
                all_cards.remove(card)
        
        # Remove played cards (from events)
        played_all = []
        for event in game_state.get('events', []):
            if event.get('type') == 'play':
                cards = event.get('cards', [])
                for card_obj in cards:
                    card_int = RealCard2EnvCard[card_obj['r']]
                    if card_int in all_cards:
                        all_cards.remove(card_int)
                    played_all.append(card_int)
        
        other_handcards = _cards2array(all_cards)
        other_handcards_batch = np.repeat(other_handcards[np.newaxis, :],
                                          num_legal_actions, axis=0)
        
        # Last action
        last_action_cards = []
        trick = game_state.get('trick')
        if trick and trick.get('cards'):
            last_action_cards = [RealCard2EnvCard[c['r']] for c in trick['cards']]
        last_action = _cards2array(last_action_cards)
        last_action_batch = np.repeat(last_action[np.newaxis, :],
                                      num_legal_actions, axis=0)
        
        # Action encoding
        my_action_batch = np.zeros(my_handcards_batch.shape)
        for j, action in enumerate(legal_actions):
            my_action_batch[j, :] = _cards2array(action)
        
        # Track played cards by each player
        played_by_player = {i: [] for i in range(4)}
        for event in game_state.get('events', []):
            if event.get('type') == 'play':
                p = event.get('p')
                cards = event.get('cards', [])
                for card_obj in cards:
                    played_by_player[p].append(RealCard2EnvCard[card_obj['r']])
        
        # Track cards left for each player
        num_cards_left = {i: len(hands_int[i]) for i in range(4)}
        
        # Bomb count
        bomb_count = game_state.get('bombCount', 0)
        bomb_num = _get_one_hot_bomb(bomb_count)
        bomb_num_batch = np.repeat(bomb_num[np.newaxis, :],
                                   num_legal_actions, axis=0)
        
        # Build position-specific features
        if position == 'landlord':
            # Landlord features
            farmer_next_idx = (landlord_idx + 1) % 4
            farmer_across_idx = (landlord_idx + 2) % 4
            farmer_prev_idx = (landlord_idx + 3) % 4
            
            farmer_next_played = _cards2array(played_by_player[farmer_next_idx])
            farmer_across_played = _cards2array(played_by_player[farmer_across_idx])
            farmer_prev_played = _cards2array(played_by_player[farmer_prev_idx])
            
            farmer_next_num_cards = _get_one_hot_array(num_cards_left[farmer_next_idx], 13)
            farmer_across_num_cards = _get_one_hot_array(num_cards_left[farmer_across_idx], 13)
            farmer_prev_num_cards = _get_one_hot_array(num_cards_left[farmer_prev_idx], 13)
            
            # Repeat for batch
            farmer_next_played_batch = np.repeat(farmer_next_played[np.newaxis, :], num_legal_actions, axis=0)
            farmer_across_played_batch = np.repeat(farmer_across_played[np.newaxis, :], num_legal_actions, axis=0)
            farmer_prev_played_batch = np.repeat(farmer_prev_played[np.newaxis, :], num_legal_actions, axis=0)
            farmer_next_num_cards_batch = np.repeat(farmer_next_num_cards[np.newaxis, :], num_legal_actions, axis=0)
            farmer_across_num_cards_batch = np.repeat(farmer_across_num_cards[np.newaxis, :], num_legal_actions, axis=0)
            farmer_prev_num_cards_batch = np.repeat(farmer_prev_num_cards[np.newaxis, :], num_legal_actions, axis=0)
            
            x_batch = np.hstack((my_handcards_batch,
                                other_handcards_batch,
                                last_action_batch,
                                farmer_next_played_batch,
                                farmer_across_played_batch,
                                farmer_prev_played_batch,
                                farmer_next_num_cards_batch,
                                farmer_across_num_cards_batch,
                                farmer_prev_num_cards_batch,
                                bomb_num_batch,
                                my_action_batch))
        else:
            # Farmer features
            if position == 'landlord_next':
                teammates = [(landlord_idx + 2) % 4, (landlord_idx + 3) % 4]
            elif position == 'landlord_across':
                teammates = [(landlord_idx + 3) % 4, (landlord_idx + 1) % 4]
            else:  # landlord_prev
                teammates = [(landlord_idx + 1) % 4, (landlord_idx + 2) % 4]
            
            landlord_played = _cards2array(played_by_player[landlord_idx])
            teammate1_played = _cards2array(played_by_player[teammates[0]])
            teammate2_played = _cards2array(played_by_player[teammates[1]])
            
            landlord_num_cards = _get_one_hot_array(num_cards_left[landlord_idx], 17)
            teammate1_num_cards = _get_one_hot_array(num_cards_left[teammates[0]], 13)
            teammate2_num_cards = _get_one_hot_array(num_cards_left[teammates[1]], 13)
            
            # Repeat for batch
            landlord_played_batch = np.repeat(landlord_played[np.newaxis, :], num_legal_actions, axis=0)
            teammate1_played_batch = np.repeat(teammate1_played[np.newaxis, :], num_legal_actions, axis=0)
            teammate2_played_batch = np.repeat(teammate2_played[np.newaxis, :], num_legal_actions, axis=0)
            landlord_num_cards_batch = np.repeat(landlord_num_cards[np.newaxis, :], num_legal_actions, axis=0)
            teammate1_num_cards_batch = np.repeat(teammate1_num_cards[np.newaxis, :], num_legal_actions, axis=0)
            teammate2_num_cards_batch = np.repeat(teammate2_num_cards[np.newaxis, :], num_legal_actions, axis=0)
            
            x_batch = np.hstack((my_handcards_batch,
                                other_handcards_batch,
                                last_action_batch,
                                landlord_played_batch,
                                teammate1_played_batch,
                                teammate2_played_batch,
                                landlord_num_cards_batch,
                                teammate1_num_cards_batch,
                                teammate2_num_cards_batch,
                                bomb_num_batch,
                                my_action_batch))
        
        # Build action sequence for LSTM (include both play and pass)
        action_sequence = []
        for event in game_state.get('events', []):
            et = event.get('type') if isinstance(event, dict) else None
            if et == 'play':
                cards = event.get('cards', [])
                if len(cards) > 0:
                    action_cards = [RealCard2EnvCard[c['r']] for c in cards]
                    action_sequence.append(action_cards)
                else:
                    action_sequence.append([])
            elif et == 'pass':
                action_sequence.append([])
        
        z_batch = self._encode_z(action_sequence, num_legal_actions)

        obs = {
            'position': position,
            'x_batch': x_batch.astype(np.float32),
            'z_batch': z_batch.astype(np.float32),
            'legal_actions': legal_actions,
        }
        
        return obs
    
    def _encode_z(self, action_sequence, num_legal_actions):
        """Encode action history into z_batch (LSTM format: B x 5 x 208)."""
        z = _action_seq_list2array(_process_action_seq(action_sequence))
        return np.repeat(z[np.newaxis, :, :], num_legal_actions, axis=0)

    def _cards_to_js(self, action_cards):
        """Convert integer card list to JS format."""
        if not action_cards:
            return None  # Pass
        
        js_cards = []
        for card_int in action_cards:
            rank_str = EnvCard2RealCard[card_int]
            # Assign dummy suit (web app tracks suits but model doesn't use them)
            js_cards.append({'r': rank_str, 's': 'S'})
        
        return js_cards


class AttnV1Agent(AIAgent):
    """
    AI agent using the attn_v1 transformer checkpoint from DouZero.
    Uses ResNet + Transformer z-encoder (d=256, 4 layers) trained with
    opponent pool. z_batch shape: (B, 32, 52) instead of LSTM's (B, 5, 208).
    """

    def __init__(self, checkpoint_dir=None):
        if checkpoint_dir is None:
            checkpoint_dir = DOUZERO_ROOT / 'douzero_checkpoints' / 'attn_v1'
        # Add DouZero (transformer branch) to path for model_dict
        if DOUZERO_ROOT.exists() and str(DOUZERO_ROOT) not in sys.path:
            sys.path.insert(0, str(DOUZERO_ROOT))
        # Call grandparent __init__ logic manually (skip AIAgent.__init__ would
        # re-call _load_models after path setup, which is fine)
        self.checkpoint_dir = Path(checkpoint_dir)
        self.device = torch.device('cpu')
        self.models = {}
        print(f"[attn_v1] Loading transformer models from {self.checkpoint_dir}")
        self._load_models()
        print("[attn_v1] Models loaded successfully")

    def _load_models(self):
        """Load all four positions using the transformer ResNet model_dict."""
        from douzero.dmc.models import model_dict
        for position in POSITIONS:
            # Pick the latest checkpoint by frame number
            ckpt_files = sorted(
                self.checkpoint_dir.glob(f"{position}_weights_*.ckpt"),
                key=lambda p: int(p.stem.split('_')[-1])
            )
            if not ckpt_files:
                raise FileNotFoundError(f"No checkpoint found for {position} in {self.checkpoint_dir}")
            ckpt_path = ckpt_files[-1]
            print(f"  Loading {position} from {ckpt_path.name}")

            model = model_dict[position](z_encoder='transformer')
            model_state = model.state_dict()
            pretrained = torch.load(ckpt_path, map_location=self.device)
            pretrained = {k: v for k, v in pretrained.items() if k in model_state}
            model_state.update(pretrained)
            model.load_state_dict(model_state)
            model.to(self.device)
            model.eval()
            self.models[position] = model

    def _encode_z(self, action_sequence, num_legal_actions):
        """Encode action history into z_batch (transformer format: B x 32 x 52)."""
        z = _action_seq_list2array_transformer(_process_action_seq_v2(action_sequence, 32))
        return np.repeat(z[np.newaxis, :, :], num_legal_actions, axis=0)


# Global agent instance
_agent = None


def get_agent(checkpoint_dir=None):
    """Get or create global AI agent instance (defaults to attn_v1)."""
    global _agent, MODEL_INFO
    if _agent is None:
        _agent = AttnV1Agent(checkpoint_dir)
        # Determine frame count from latest landlord checkpoint
        ckpt_files = sorted(
            _agent.checkpoint_dir.glob('landlord_weights_*.ckpt'),
            key=lambda p: int(p.stem.split('_')[-1])
        )
        frames = int(ckpt_files[-1].stem.split('_')[-1]) if ckpt_files else 0
        MODEL_INFO = {
            'name': 'attn_v1',
            'description': 'Transformer z-encoder (d=256, 4L) + Dueling DQN + opponent pool',
            'frames': frames,
            'wp_vs_random': 0.882,
            'z_encoder': 'transformer',
            'checkpoint_dir': str(_agent.checkpoint_dir),
        }
    return _agent
