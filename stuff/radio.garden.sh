#!/bin/bash

# download the main json file which stores all location ids
curl -s 'https://radio.garden/api/ara/content/secure/places-core' -H 'User-Agent: Mozilla/5.0' -H 'Accept: */*' -H 'Accept-Language: en-US' -H 'Accept-Encoding: gzip, deflate' -H 'Referer: https://radio.garden/' -H 'Connection: keep-alive' | jq . | grep id | awk -F '"' '{print $4}' > places.txt

# download every sub json file for each id
for i in $(cat places.txt) ; do curl -s https://radio.garden/api/ara/content/secure/page/$i -H 'User-Agent: Mozilla/5.0' --compressed > $i.json ; done

# extract the location, title and stream url (not the link yet)
for i in *.json ; do cat $i | jq -r '.data.content[].items[]?.page | "\\(.subtitle)_____\\(.title)_____\\(.url)"' | grep '/listen/' >> every.txt ; done

# add stream urls from each location to a file with that location name
awk -F '_____' '{gsub(/ /,"_",$1); gsub(/[\\/:*?"<>|]/,"",$1); print > ($1 ".txt")}' every.txt

# strip the unnecessary parts of each file, only keep title and url id
for i in *.txt ; do cat $i | sed 's| |_|g' | awk -F '_____' '{print $2 $3}' | awk -F '/' '{print $1"/"$4}' > A-$i ; done

# scrape stream links by sending request to the api
for i in *.txt ; do for j in $(cat $i) ; do echo $j | awk -F '/' '{print $1}' | awk '{print "#EXTINF:-1,"$0}' >> A$i ; curl -s https://radio.garden/api/ara/content/listen/$(echo $j | awk -F '/' '{print $2}')/channel.mp3 -H 'User-Agent: Mozilla/5.0' -H 'Accept: audio/*' -H 'Range: bytes=0-' -H 'Connection: keep-alive' -H 'DNT: 1' | awk -F '"' '{print $2}' | sed 's|;||g' | sed '/^$/d' >> A$i ; done ; done

# normilize filenames 
find . -type f -exec bash -c 'for file; do normalized_name=$(echo "$file" | iconv -f UTF-8 -t ASCII//TRANSLIT | tr "[:space:]" "_" | tr -cd "[:alnum:]_.-"); normalized_name="${normalized_name#.}"; normalized_name="${normalized_name%_}"; [[ "$normalized_name" != "$file" ]] && mv -vi "$file" "$(dirname "$file")/$normalized_name"; done' bash {} +

# remove streams that didn't have links
for i in A-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done
