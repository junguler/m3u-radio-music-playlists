#!/bin/bash

# get the list of all categories
curl -s https://radiomixer.net/en/genres | htmlq -a href a | grep '/en/genre/' | sort | uniq | awk -F '/' '{print $6}' > genres.txt
curl -s https://radiomixer.net/en | htmlq div.menuitem | grep 'dropdown-item' | awk '{print $5"-"$6"-"$7}' | awk -F '/' '{print $5}' | sed -e 's|>||g' -e 's|<||g' -e 's|"|__|g' | sort > countries.txt
curl -s https://radiomixer.net/en | htmlq -a href a | grep 'continent' | awk -F '/' '{print $6}' > continents.txt

# extract the station names of everything
for i in "" \?page={2..5} ; do for j in $(cat genres.txt) ; do curl -s https://radiomixer.net/en/genre/$j$i | htmlq .col-md -a href a | uniq | grep -v 'page=' | awk -F '/' '{print $5"/"$6}' | grep -E '.+/[^/]+' >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" \?page={2..5} ; do for j in $(cat countries.txt) ; do curl -s https://radiomixer.net/en/$(echo $j | awk -F '__' '{print $1}')$i | htmlq .col-md -a href a | uniq | grep -v 'page=' | awk -F '/' '{print $5"/"$6}' | grep -E '.+/[^/]+' >> A-$(echo $j | awk -F '__' '{print $2}').txt ; echo -e "$j - $i" ; done ; done
for i in "" \?page={2..5} ; do for j in $(cat continents.txt) ; do curl -s https://radiomixer.net/en/continent/$j$i | htmlq .col-md -a href a | uniq | grep -v 'page=' | awk -F '/' '{print $5"/"$6}' | grep -E '.+/[^/]+' >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# extract stream links and name
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://radiomixer.net/en/$j > mep1 ; cat mep1 | htmlq -t h1 | awk 'NR==1 {$0="#EXTINF:-1," $0} 1' | sed 's| Radio listen live||g' | sed 's| listen live||g' >> A$i ; cat mep1 | grep 'data-id' | sed -n '2p' | awk -F '"' '{print $2}' > iidd ; curl -s https://radiomixer.net/en/api/station/$(cat iidd)/stream | htmlq -a href a | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links - convert weird links to proper http
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
