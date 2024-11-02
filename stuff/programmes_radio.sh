#!/bin/bash

# extract all the api data 
for i in "" \&offset={48..59040..48} ; do curl -s 'https://api.programmes-radio.com/stream?sort=popularity$i' --compressed -H 'User-Agent: Mozilla/5.0' -H 'Accept: */*' >> main.json ; echo $i ; done

# prettify and tableized data
cat main.json | jq -r '.streams[] | [.name, .country_code, .stream_url, .tags] | @csv' | sed 's| |_|g' > main.csv

# extract country list
curl 'https://api.programmes-radio.com/countries?locale=en' | jq .countries | awk -F '"' '{print $2"__"$4}' | awk 'length>4' | sed 's| |_|g' > countries.txt

# extract genre tags and create a genre list
cat main.csv | awk -F '"' '{print $8}' | awk NF | tr ',' '\n' | sort | uniq > genres.txt

# extract genre playlists
for i in $(cat genres.txt) ; do cat main.csv | grep -i $i | awk -F '"' '{print "#EXTINF:-1,"$2 "\n" $6}' | sed '/^#/s/_/ /g' | awk '!seen[$0]++' >> A-$i.txt ; done

# extract country playlists
for i in $(cat countries.txt) ; do cat main.csv | grep -i $(echo $i | awk -F '__' '{print $1}') | awk -F '"' '{print "#EXTINF:-1,"$2 "\n" $6}' | sed '/^#/s/_/ /g' | awk '!seen[$0]++' >> A-$(echo $i | awk -F '__' '{print $2}').txt ; done

# normilize filenames 
find . -type f -exec bash -c 'for file; do normalized_name=$(echo "$file" | iconv -f UTF-8 -t ASCII//TRANSLIT | tr "[:space:]" "_" | tr -cd "[:alnum:]_.-"); normalized_name="${normalized_name#.}"; normalized_name="${normalized_name%_}"; [[ "$normalized_name" != "$file" ]] && mv -vi "$file" "$(dirname "$file")/$normalized_name"; done' bash {} +

# create all.m3u playlist - most of the streams didn't have a genre tag so here is the place they all went
for i in A-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done
