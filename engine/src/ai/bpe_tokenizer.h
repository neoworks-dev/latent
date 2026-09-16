// Florence-2's tokenizer: BART/RoBERTa byte-level BPE, read straight out of `vocab.json`
// and `merges.txt`. Two hundred lines beat a third-party dependency for a model whose only
// input is one English noun phrase.
//
// Byte level means the text is first mapped byte by byte into a 256-character alphabet
// (GPT-2's `bytes_to_unicode`: a space becomes U+0120 'G-dot'), so any input encodes and
// no token is ever unknown. Pre-tokenisation follows GPT-2's regex, restricted to ASCII
// letters and digits: mask prompts are English, and the alternative is a Unicode property
// table for no gain.
#pragma once

#include <cstdint>

#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace latent {

class BpeTokenizer {
 public:
  // Reads `<directory>/vocab.json`, `merges.txt` and, when it is there,
  // `added_tokens.json` — which is where Florence-2's 1024 `<loc_###>` ids live.
  // Throws std::runtime_error when a file is missing or malformed.
  static BpeTokenizer from_directory(const std::string& directory);

  // No BOS/EOS: Florence-2 builds its own sequence around the prompt.
  std::vector<int64_t> encode(std::string_view text) const;

  // Keeps special tokens, which is the only way `<loc_###>` survives to the box parser.
  std::string decode(std::span<const int64_t> ids) const;

  size_t vocabulary_size() const { return pieces_.size(); }

 private:
  std::unordered_map<std::string, int64_t> vocabulary_;
  // id -> piece, for decode. Sparse ids leave empty strings behind.
  std::vector<std::string> pieces_;
  // "<left> <right>" -> merge priority, lowest first.
  std::unordered_map<std::string, int32_t> merges_;
};

}  // namespace latent
