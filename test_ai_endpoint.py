#!/usr/bin/env python3
"""Test the AI endpoint with a simple game state."""
import json
import requests
import time

# Create a minimal game state for testing
test_game_state = {
    "hands": [
        # P0 (human) - 12 cards
        [{"r": "4", "s": "S"}, {"r": "5", "s": "H"}, {"r": "6", "s": "D"}, 
         {"r": "7", "s": "C"}, {"r": "8", "s": "S"}, {"r": "9", "s": "H"},
         {"r": "10", "s": "D"}, {"r": "J", "s": "C"}, {"r": "Q", "s": "S"},
         {"r": "K", "s": "H"}, {"r": "A", "s": "D"}, {"r": "2", "s": "C"}],
        # P1 (AI landlord_next) - 12 cards
        [{"r": "4", "s": "H"},{"r": "5", "s": "D"}, {"r": "6", "s": "C"}, 
         {"r": "7", "s": "S"}, {"r": "8", "s": "H"}, {"r": "9", "s": "D"},
         {"r": "10", "s": "C"}, {"r": "J", "s": "S"}, {"r": "Q", "s": "H"},
         {"r": "K", "s": "D"}, {"r": "A", "s": "C"}, {"r": "2", "s": "S"}],
        # P2 (AI landlord_across) - 12 cards
        [{"r": "4", "s": "D"}, {"r": "5", "s": "C"}, {"r": "6", "s": "S"}, 
         {"r": "7", "s": "H"}, {"r": "8", "s": "D"}, {"r": "9", "s": "C"},
         {"r": "10", "s": "S"}, {"r": "J", "s": "H"}, {"r": "Q", "s": "D"},
         {"r": "K", "s": "C"}, {"r": "A", "s": "S"}, {"r": "2", "s": "H"}],
        # P3 (AI landlord_prev) - 16 cards (landlord)
        [{"r": "4", "s": "C"}, {"r": "5", "s": "S"}, {"r": "6", "s": "H"}, 
         {"r": "7", "s": "D"}, {"r": "8", "s": "C"}, {"r": "9", "s": "S"},
         {"r": "10", "s": "H"}, {"r": "J", "s": "D"}, {"r": "Q", "s": "C"},
         {"r": "K", "s": "S"}, {"r": "A", "s": "H"}, {"r": "2", "s": "D"},
         {"r": "3", "s": "S"}, {"r": "3", "s": "H"}, {"r": "3", "s": "D"}, {"r": "3", "s": "C"}],
    ],
    "landlord": 3,  # P3 is landlord
    "trick": None,  # No current trick (landlord to lead)
    "lastBy": None,
    "passes": 0,
    "events": [
        {"t": 1234567890, "type": "start", "game_id": "test-123"}
    ],
    "bombCount": 0
}

print("Testing AI endpoint...")
print(f"Game state: P3 is landlord with 16 cards, ready to lead")
print()

# Test P3 (landlord) decision
start = time.time()
response = requests.post('http://localhost:8099/api/get_ai_action', json={
    'game_state': test_game_state,
    'player_position': 3
})
elapsed = time.time() - start

print(f"Response status: {response.status_code}")
print(f"Response time: {elapsed:.3f}s")

if response.status_code == 200:
    data = response.json()
    print(f"Response: {json.dumps(data, indent=2)}")
    if data.get('ok'):
        action = data.get('action')
        if action:
            cards_str = ', '.join([c['r'] for c in action])
            print(f"\nAI decision: Play {cards_str}")
        else:
            print(f"\nAI decision: Pass")
    else:
        print(f"Error: {data.get('error')}")
else:
    print(f"HTTP error: {response.text}")
