#!/bin/bash

# find links in genres, locations, languages 
curl -s https://vtuner.com/setupapp/guide/asp/BrowseStations/StartPage.asp\?sBrowseType\=Format | htmlq -a href a | grep "PremiumStations" | sort | uniq | awk -F '=' '{print $2}' | awk -F '&' '{print $1}' | sed 's/ /%20/g' > genres.txt
curl -s https://vtuner.com/setupapp/guide/asp/BrowseStations/StartPage.asp\?sBrowseType\=Location | htmlq -a href a | grep "PremiumStations" | sort | uniq | awk -F '=' '{print $2}' | awk -F '&' '{print $1}' | sed 's/ /%20/g' > location.txt
curl -s https://vtuner.com/setupapp/guide/asp/BrowseStations/StartPage.asp\?sBrowseType\=Language | htmlq -a href a | grep "BrowseStations" | sort | uniq | awk -F '=' '{print $2}' | awk -F '&' '{print $1}' | sed 's/ /%20/g' | awk NF | tail -n +4 > languages.txt

# find first page for each category
for j in $(cat genres.txt) ; do curl -s https://vtuner.com/setupapp/guide/asp/BrowseStations/BrowsePremiumStations.asp\?sCategory\=$j\&sBrowseType\=Format\&sNiceLOFO\=$j | htmlq -a href a | uniq | grep "dynampls.asp" | awk -F '=' '{print $2"="$3}' > A-$j.txt ; echo -e $j ; done
for j in $(cat location.txt) ; do curl -s https://vtuner.com/setupapp/guide/asp/BrowseStations/BrowsePremiumStations.asp\?sCategory\=$j\&sBrowseType\=Location\&sNiceLOFO\=$j | htmlq -a href a | uniq | grep "dynampls.asp" | awk -F '=' '{print $2"="$3}' > A-$j.txt ; echo -e $j ; done
for j in $(cat languages.txt) ; do curl -s https://vtuner.com/setupapp/guide/asp/BrowseStations/BrowsePremiumStations.asp\?sCategory\=$j\&sWhatList\=ALL\&sBrowseType\=Language | htmlq -a href a | uniq | grep "dynampls.asp" | awk -F '=' '{print $2"="$3}' > A-lang-$j.txt ; echo -e $j ; done

#scrape the rest of pages
for i in {2..200} ; do for j in $(cat genres.txt) ; do curl -s https://vtuner.com/setupapp/guide/asp/BrowseStations/BrowsePremiumStations.asp\?sCategory\=$j\&sBrowseType\=Format\&sViewBy\=\&sSortby\=\&sWhatList\=\&sNiceLang\=\&iCurrPage\=$i | htmlq -a href a | uniq | grep "dynampls.asp" | awk -F '=' '{print $2"="$3}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in {2..200} ; do for j in $(cat location.txt) ; do curl -s https://vtuner.com/setupapp/guide/asp/BrowseStations/BrowsePremiumStations.asp\?sCategory\=$j\&sBrowseType\=Location\&sViewBy\=\&sSortby\=\&sWhatList\=\&sNiceLang\=\&iCurrPage\=$i | htmlq -a href a | uniq | grep "dynampls.asp" | awk -F '=' '{print $2"="$3}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in {2..200} ; do for j in $(cat languages.txt) ; do curl -s https://vtuner.com/setupapp/guide/asp/BrowseStations/BrowsePremiumStations.asp\?sCategory\=$j\&sBrowseType\=Language\&sViewBy\=\&sSortby\=\&sWhatList\=ALL\&sNiceLang\=\&iCurrPage\=$i | htmlq -a href a | uniq | grep "dynampls.asp" | awk -F '=' '{print $2"="$3}' >> A-lang-$j.txt ; echo -e "$j - $i" ; done ; done

# scrape the streams
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://vtuner.com/setupapp/guide/asp/BrowseStations/dynampls.asp\?id\=$j > mep1 ; cat mep1 | htmlq \#StatName -t | awk '{print "#EXTINF:-1 , "$0}' >> A$i ; cat mep1 | grep "var rawUrl" | uniq | awk -F '"' '{print $2}' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# convert links to m3u streams
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done

# replace %20 in file names with _
for i in *.m3u ; do mv -- "$i" "$(printf '%s\n' "$i" | sed 's/%20/_/')" ; done
