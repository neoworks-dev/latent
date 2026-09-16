#include "ai/bpe_tokenizer.h"

#include "ai/model_store.h"

#include <algorithm>
#include <array>
#include <fstream>
#include <limits>
#include <stdexcept>

namespace latent {

namespace {

// GPT-2's bytes_to_unicode: every byte gets a printable code point, so the alphabet is
// 256 characters wide and nothing is ever out of vocabulary. Bytes that are already
// printable map to themselves; the other 68 are pushed up to U+0100 and above.
std::string utf8_of(uint32_t code_point) {
  std::string out;
  if (code_point < 0x80) {
    out.push_back(static_cast<char>(code_point));
  } else if (code_point < 0x800) {
    out.push_back(static_cast<char>(0xC0 | (code_point >> 6)));
    out.push_back(static_cast<char>(0x80 | (code_point & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xE0 | (code_point >> 12)));
    out.push_back(static_cast<char>(0x80 | ((code_point >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (code_point & 0x3F)));
  }
  return out;
}

bool printable_byte(uint32_t byte) {
  return (byte >= '!' && byte <= '~') || (byte >= 0xA1 && byte <= 0xAC) || (byte >= 0xAE);
}

struct ByteAlphabet {
  std::array<std::string, 256> forward;
  std::unordered_map<uint32_t, uint8_t> backward;

  ByteAlphabet() {
    uint32_t spare = 0;
    for (uint32_t byte = 0; byte < 256; ++byte) {
      const uint32_t code_point = printable_byte(byte) ? byte : 256 + spare;
      if (!printable_byte(byte)) ++spare;
      forward[byte] = utf8_of(code_point);
      backward[code_point] = static_cast<uint8_t>(byte);
    }
  }
};

const ByteAlphabet& alphabet() {
  static const ByteAlphabet table;
  return table;
}

bool is_space(char value) {
  const auto byte = static_cast<unsigned char>(value);
  return byte == ' ' || byte == '\t' || byte == '\n' || byte == '\r' || byte == '\v' ||
         byte == '\f';
}

// \p{L} and \p{N} narrowed to ASCII; everything else lands in the third class, which is
// what GPT-2's `[^\s\p{L}\p{N}]+` branch collects.
enum class CharClass : uint8_t { Letter, Digit, Other };

CharClass classify(char value) {
  const auto byte = static_cast<unsigned char>(value);
  if ((byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z')) return CharClass::Letter;
  if (byte >= '0' && byte <= '9') return CharClass::Digit;
  return CharClass::Other;
}

size_t contraction_length(std::string_view text, size_t at) {
  static constexpr std::array<std::string_view, 7> kContractions{"'s", "'t",  "'re", "'ve",
                                                                 "'m", "'ll", "'d"};
  for (std::string_view contraction : kContractions) {
    if (text.compare(at, contraction.size(), contraction) == 0) return contraction.size();
  }
  return 0;
}

// GPT-2's pre-tokenisation regex, spelled out:
//   's|'t|'re|'ve|'m|'ll|'d | ?\p{L}+ | ?\p{N}+ | ?[^\s\p{L}\p{N}]+ | \s+(?!\S) | \s+
std::vector<std::string_view> pre_tokenize(std::string_view text) {
  std::vector<std::string_view> pieces;
  size_t at = 0;
  while (at < text.size()) {
    if (text[at] == '\'') {
      const size_t length = contraction_length(text, at);
      if (length > 0) {
        pieces.push_back(text.substr(at, length));
        at += length;
        continue;
      }
    }
    // One optional leading space, then a run of a single character class.
    size_t start = at;
    if (text[start] == ' ') ++start;
    if (start < text.size() && !is_space(text[start])) {
      const CharClass kind = classify(text[start]);
      size_t end = start;
      while (end < text.size() && !is_space(text[end]) && classify(text[end]) == kind) {
        ++end;
      }
      pieces.push_back(text.substr(at, end - at));
      at = end;
      continue;
    }
    // A whitespace run. `\s+(?!\S)` hands the last character of an interior run to the
    // next token, which is how " a" keeps its space; a run at the end is taken whole.
    size_t end = at;
    while (end < text.size() && is_space(text[end])) {
      ++end;
    }
    const size_t stop = (end < text.size() && end - at > 1) ? end - 1 : end;
    pieces.push_back(text.substr(at, stop - at));
    at = stop;
  }
  return pieces;
}

std::string merge_key(const std::string& left, const std::string& right) {
  return left + " " + right;
}

}  // namespace

BpeTokenizer BpeTokenizer::from_directory(const std::string& directory) {
  BpeTokenizer tokenizer;
  const nlohmann::json vocabulary = read_json_file(directory + "/vocab.json");
  int64_t highest = -1;
  for (auto entry = vocabulary.begin(); entry != vocabulary.end(); ++entry) {
    const auto id = entry.value().get<int64_t>();
    tokenizer.vocabulary_[entry.key()] = id;
    highest = std::max(highest, id);
  }

  const std::string added_path = directory + "/added_tokens.json";
  std::ifstream added_probe(added_path);
  if (added_probe) {
    added_probe.close();
    const nlohmann::json added = read_json_file(added_path);
    for (auto entry = added.begin(); entry != added.end(); ++entry) {
      const auto id = entry.value().get<int64_t>();
      tokenizer.vocabulary_[entry.key()] = id;
      highest = std::max(highest, id);
    }
  }
  tokenizer.pieces_.assign(static_cast<size_t>(highest + 1), std::string());
  for (const auto& [piece, id] : tokenizer.vocabulary_) {
    tokenizer.pieces_[static_cast<size_t>(id)] = piece;
  }

  std::ifstream merges(directory + "/merges.txt");
  if (!merges) throw std::runtime_error("cannot read " + directory + "/merges.txt");
  std::string line;
  int32_t rank = 0;
  while (std::getline(merges, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty() || line.starts_with("#version")) continue;
    if (line.find(' ') == std::string::npos) continue;
    tokenizer.merges_.emplace(line, rank++);
  }
  if (tokenizer.merges_.empty()) {
    throw std::runtime_error(directory + "/merges.txt holds no merges");
  }
  return tokenizer;
}

std::vector<int64_t> BpeTokenizer::encode(std::string_view text) const {
  std::vector<int64_t> ids;
  for (std::string_view piece : pre_tokenize(text)) {
    // Byte level: one symbol per input byte to start with.
    std::vector<std::string> symbols;
    symbols.reserve(piece.size());
    for (char byte : piece) {
      symbols.push_back(alphabet().forward[static_cast<unsigned char>(byte)]);
    }

    // Merge the single best-ranked adjacent pair, repeatedly, exactly like GPT-2.
    while (symbols.size() > 1) {
      int32_t best_rank = std::numeric_limits<int32_t>::max();
      size_t best_at = 0;
      for (size_t i = 0; i + 1 < symbols.size(); ++i) {
        const auto found = merges_.find(merge_key(symbols[i], symbols[i + 1]));
        if (found == merges_.end() || found->second >= best_rank) continue;
        best_rank = found->second;
        best_at = i;
      }
      if (best_rank == std::numeric_limits<int32_t>::max()) break;

      const std::string left = symbols[best_at];
      const std::string right = symbols[best_at + 1];
      std::vector<std::string> merged;
      merged.reserve(symbols.size());
      for (size_t i = 0; i < symbols.size();) {
        if (i + 1 < symbols.size() && symbols[i] == left && symbols[i + 1] == right) {
          merged.push_back(left + right);
          i += 2;
          continue;
        }
        merged.push_back(symbols[i]);
        ++i;
      }
      symbols = std::move(merged);
    }

    for (const std::string& symbol : symbols) {
      const auto found = vocabulary_.find(symbol);
      if (found == vocabulary_.end()) {
        throw std::runtime_error("tokenizer: '" + symbol + "' is not in the vocabulary");
      }
      ids.push_back(found->second);
    }
  }
  return ids;
}

std::string BpeTokenizer::decode(std::span<const int64_t> ids) const {
  std::string encoded;
  for (int64_t id : ids) {
    if (id < 0 || static_cast<size_t>(id) >= pieces_.size()) continue;
    encoded += pieces_[static_cast<size_t>(id)];
  }

  // Back through the byte alphabet: read one UTF-8 code point at a time and look up the
  // byte it stands for.
  std::string out;
  for (size_t at = 0; at < encoded.size();) {
    const auto lead = static_cast<unsigned char>(encoded[at]);
    uint32_t code_point = lead;
    size_t width = 1;
    if ((lead & 0xE0) == 0xC0) {
      width = 2;
      code_point = lead & 0x1FU;
    } else if ((lead & 0xF0) == 0xE0) {
      width = 3;
      code_point = lead & 0x0FU;
    }
    if (at + width > encoded.size()) break;
    for (size_t i = 1; i < width; ++i) {
      code_point = (code_point << 6) | (static_cast<unsigned char>(encoded[at + i]) & 0x3FU);
    }
    at += width;
    const auto found = alphabet().backward.find(code_point);
    out.push_back(found == alphabet().backward.end() ? '?' : static_cast<char>(found->second));
  }
  return out;
}

}  // namespace latent
