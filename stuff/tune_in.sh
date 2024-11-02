#!/bin/bash

# get the list of all stream ids
curl -s 'https://cdn-web.tunein.com/assets/mapViewData/1970326d.json' --compressed -H 'User-Agent: Mozilla/5.0' -H 'Accept: */*' > streams.json

# extract the station name, id and location
cat streams.json | jq -r '.stations[] | "\\(.freeGuideId)_____\\(.title)_____\\(.genreIds | join(","))"' > streams.txt

# create the stream title and links
for i in $(cat streams.txt) ; do echo $i | awk -F '_____' '{print $2"___"$3}' | awk '{print "#EXTINF:-1,"$0}' >> output.txt ; curl -s https://opml.radiotime.com/Tune.ashx?id=$(echo $i | awk -F '_____' '{print $1}')&formats=mp3,aac,ogg,flash,html,hls,wma&version=6.71&itemUrlScheme=secure&render=json&reqAttempt=1 --compressed -H 'User-Agent: Mozilla/5.0' -H 'Accept: application/json' -H 'Referer: https://tunein.com/' | grep url | awk -F '"' '{print $4}' >> output.txt ; done

# extract the actual data from the api
for i in $(cat *.txt) ; do echo $i | awk '{print "#EXTINF:-1,"$0}' >> output ; curl -s "https://opml.radiotime.com/Tune.ashx?id=$(echo $i | awk -F '_____' '{print $1}')&formats=mp3,aac,ogg,flash,html,hls,wma&version=6.71&itemUrlScheme=secure&render=json&reqAttempt=1" --compressed -H 'User-Agent: Mozilla/5.0' -H 'Accept: application/json' -H 'Referer: https://tunein.com/' | grep url | awk -F '"' '{print $4}' >> output ; echo $i ; done

# get a list of common genres manually to send to the websites api, i've used my own +merged+ folder

# search the api using genre keywords
for i in $(cat list.txt) ; do curl -s "https://api.tunein.com/profiles?fullTextSearch=true&query=$i&filter=s&ignoreProfileRedirect=true&ignoreCategoryRedirect=true&formats=mp3,aac,ogg,flash,html,hls,wma&partnerId=RadioTime&version=6.71&itemUrlScheme=secure&reqAttempt=1" --compressed -H 'User-Agent: Mozilla/5.0' -H 'Accept: application/json' > $i.json ; echo $i ; done

# create unique text files for each genre
for i in *.json ; do cat $i | jq . | grep GuideId | awk -F '"' '{print $4}' | uniq > $(echo $i | sed 's|.json||g').txt ; done

# extract streams title and link from the giant output file
for i in *.txt ; do for j in $(cat $i) ; do grep -A1 $j output | awk 'length>4' >> A-$i ; echo -e "$i - $j" ; done ; done

# remove extra links and finishing touches
for i in *.txt ; do cat $i | grep -E '^#|^[^#]' | sed -E 's/^#.*?_____(.*?)_____.*/\\1/' | sed '/^http/!s/^/#EXTINF:-1,/' | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
