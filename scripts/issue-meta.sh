#!/usr/bin/env bash
# Set an issue's type and its Priority and Effort fields, as neoworks-bot.
#
#   scripts/issue-meta.sh 87 --type Feature --priority High --effort Medium
#
# Type is the org's issue type (Feature, Bug, Task). Priority (Urgent, High,
# Medium, Low) and Effort (High, Medium, Low) are org issue fields; labels can't
# carry them. Any flag left out is left as it is.

set -euo pipefail

REPO="neoworks-dev/latent"
# gh bot picks its installation from the current repo; `gh api` takes no -R.
cd "$(dirname "$0")"

# Node ids of the neoworks-dev issue types, fields and their options. They are
# stable; if one stops resolving, re-read them with the GraphQL queries
# `organization(login:"neoworks-dev") { issueFields { … options { id name } } }` and
# `repository(…) { issueTypes { nodes { id name } } }`.
declare -A TYPE_IDS=(
  [Task]=IT_kwDOBol_Kc4BCezA
  [Bug]=IT_kwDOBol_Kc4BCezD
  [Feature]=IT_kwDOBol_Kc4BCezF
)
PRIORITY_FIELD=IFSS_kgDOAVuHmQ
declare -A PRIORITY_IDS=(
  [Urgent]=IFSSO_kgDOAmAVcA
  [High]=IFSSO_kgDOAmAVcQ
  [Medium]=IFSSO_kgDOAmAVcg
  [Low]=IFSSO_kgDOAmAVcw
)
EFFORT_FIELD=IFSS_kgDOAVuHnA
declare -A EFFORT_IDS=(
  [High]=IFSSO_kgDOAmAVdA
  [Medium]=IFSSO_kgDOAmAVdQ
  [Low]=IFSSO_kgDOAmAVdg
)

usage() {
  echo "usage: $0 <issue> [--type Feature|Bug|Task] [--priority Urgent|High|Medium|Low] [--effort High|Medium|Low]" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
number="$1"
shift
type="" priority="" effort=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --type) type="$2"; shift 2 ;;
    --priority) priority="$2"; shift 2 ;;
    --effort) effort="$2"; shift 2 ;;
    *) usage ;;
  esac
done

issue_id=$(gh api "repos/$REPO/issues/$number" --jq .node_id)

if [[ -n "$type" ]]; then
  type_id="${TYPE_IDS[$type]:?unknown type $type}"
  gh bot api graphql \
    -f query='mutation($issue: ID!, $type: ID!) { updateIssueIssueType(input: {issueId: $issue, issueTypeId: $type}) { issue { number } } }' \
    -f issue="$issue_id" -f type="$type_id" >/dev/null
fi

fields=()
if [[ -n "$priority" ]]; then
  fields+=("{fieldId: \"$PRIORITY_FIELD\", singleSelectOptionId: \"${PRIORITY_IDS[$priority]:?unknown priority $priority}\"}")
fi
if [[ -n "$effort" ]]; then
  fields+=("{fieldId: \"$EFFORT_FIELD\", singleSelectOptionId: \"${EFFORT_IDS[$effort]:?unknown effort $effort}\"}")
fi
if [[ ${#fields[@]} -gt 0 ]]; then
  joined=$(IFS=,; echo "${fields[*]}")
  gh bot api graphql \
    -f query="mutation(\$issue: ID!) { setIssueFieldValue(input: {issueId: \$issue, issueFields: [$joined]}) { clientMutationId } }" \
    -f issue="$issue_id" >/dev/null
fi
